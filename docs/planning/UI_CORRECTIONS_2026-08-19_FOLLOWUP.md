# Founder follow-up on the 2026-08-15 UI corrections — Plan (Rev 1)

> **Source:** founder message 2026-08-19 + `Bravo_UI_Screenshot_Review_and_Corrections (1).pdf`
> (identical content to the 15 Aug PDF; the 17-page text was re-extracted and diffed — no new
> written requirement in the document itself).
> **Companion:** `docs/planning/UI_CORRECTIONS_2026-08-15_PLAN.md` (Rev 4) is still the
> architecture reference. This file records only what the founder asked for AFTER it shipped,
> and it REVERSES one of its settled decisions (F3).

---

## 0a. BUILD STATUS (updated as it shipped)

| Ask                                              | Code            | Tests                                                              | Notes                                                                      |
| ------------------------------------------------ | --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **A** admins organisation-specific (G5/G6)       | DONE            | server 11 · admin screen 9 · invite picker 6 · **6 mutations RED** | derived scope, no migration — see the rejected list                        |
| **B** announcements inside the organisation (G4) | DONE            | model 6 · screen 4 · **3 mutations RED**                           | works whether or not the purge migration has run                           |
| **C** lateral channels at every level            | already correct | —                                                                  | **BLOCKED ON `20260816000000`** — the D-6 gate is right to hide the button |
| **D** whole-card dropdown (G1/G2/G3)             | DONE            | interaction 11 · directory 2 · scan 1 · **3 mutations RED**        | reverses F3; no door lost                                                  |

**Review:** two independent reviewers (architecture critic + edge-case hunter), **three rounds**,
each re-pointed at the previous round's fixes.

- **Round 1 — six defects in the first implementation.** One P0 (a nested broadcast under a
  bucket row vanished outright), two P1 (`scopeApplied` true when the scope covered every root;
  the invite picker never read the scope), three P2.
- **Round 2 — seven more, every one of them IN THE ROUND-1 FIXES.** Notably: the invite form
  could mint a team it displayed no selection for; the client G6 predicate was a strict subset
  of the server's, so the server 400'd what the form had invited; an archived organisation made
  the scope report itself inert. Logged **B-577..B-583**.
- **The finding that mattered most had no user impact at all:** G1 — the founder's actual ask —
  was pinned by NOTHING. The card is `accessible={false}` (required, or iOS groups the row and
  swallows every action button for VoiceOver), so all nine label-based assertions silently
  resolved the inner name touchable. Replacing the whole card with a plain `View` left five
  suites green. **Hiding an element from accessibility hides it from every label-based test —
  give it a `testID` in the same edit.**

Three further pins were found DECORATIVE during mutation and rewritten rather than kept: the
member-surface G4 call site (its fixture's only broadcast was parentless, so the helper was a
no-op there), the blocked-banner copy (its fixture produced `mixed`, not the `managersOnly`
branch it claimed to pin), and the nesting assertion itself (finding the row proves nothing —
un-nested it is still on screen, just at the root; the proof is that a nested row is HIDDEN
while its level is closed). All logged **B-569..B-583** in `sqa.md`.

**Gates:** app 173/2448 · auth-service 148/2763 · crypto 6471/6471 then 6469/6471 (moving
failure in an untouched suite, reproduces on a clean tree — the known B-126 flake) · typecheck
46 (baseline 47) · auth tsc 0 · lint 0 errors · **25 mutations verified RED**, each read back
before the run.

**Known limitation, recorded:** the scope derives from membership filtered to `role = 'admin'`.
A manager is always seeded `'admin'` so their own organisation can never be dropped, but
`memberRoleFor` also returns `'admin'` to a plain member of an `open` channel — so a manager
who merely participates in another organisation's open channel still widens their own scope.
Closing that needs a "manages organisation X" fact that does not exist. Fail-open is the safe
side; every mutation is still gated by `OrgManagerGuard` + `assertManagesChannel`.

## 0b. ACCEPTANCE-CHECKLIST SWEEP — 2026-08-20

A fresh audit of all 17 PDF §13 items against CURRENT SOURCE (plan docs and commit
messages deliberately not trusted as evidence) found **13 built, 3 partial, 1 not
built**. Three gaps were then closed — logged **B-587..B-589** in `sqa.md`:

| Item                                | Was       | Now                                                                                                                                                                                                                   |
| ----------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 08 Emergency Calls in the Calls Log | NOT BUILT | **BUILT** — recorded at the `tel:` hand-off, the only moment the OS tells us anything. Merged as a discriminated union so an emergency row cannot reach `launchCall`. SOS deliberately NOT logged: it places no call. |
| 12 Clipped Messenger buttons        | PARTIAL   | **BUILT** — the fix existed on MessengerHome and had never been ported to ChatScreen, which referenced `insets.left/right` zero times. Portrait hides it; landscape/cutout does not.                                  |
| 09 Admin-chosen level names         | PARTIAL   | **BUILT** — the tier vocabulary was FOUR drifted hardcoded copies that disagreed on screen. One resolver now; per-org names in `org_workspace_settings.level_names`; presentation-only.                               |

**Still open, both deliberately:**

- **Item 03 / the purge** — refused by its OWN security guard, not by caution. Dry
  run found 2 PENDING REKEY INTENTS on `#broadcast` in two orgs. The FK is ON
  DELETE CASCADE, so purging destroys the instruction that stops a removed member
  keeping the group master key. Drain them, then re-run.
- **Item 11a / back navigation** — needs the founder's device repro. The obvious
  fix (`backBehavior="history"`) can eject a user out of the workspace entirely
  from any of ~26 screens; measuring first was the 15-Aug conclusion and stands.

---

**MIGRATION 1 APPLIED — 2026-08-20**, to the live Supabase project `qkkfkicgoncxslbwhyhz`
(applied as `dept_channel_lateral`). Pre-flight confirmed all six pre-existing trigger guards
present before the `CREATE OR REPLACE`; post-apply verified column + default `false` + NOT NULL,
the partial index, three triggers intact, and all ten guards on the new body. **Zero rows changed:
173 channels before and after, 0 laterals, 29 live broadcasts unchanged.**

Behaviour smoke-tested inside an always-aborting `DO` block (nothing persisted, re-verified):
a lateral inherits its parent's level (2 → 2), a structural child still increments (2 → 3), and
both new refusals fire — `lateral_channel_needs_parent`, `lateral_channel_cannot_have_children`.

**Migration 2 (the purge) deliberately NOT run** — Gate 4 is unsatisfied and the snapshot turned
up a reason to pause beyond that; see `docs/runbooks/BROADCAST_PURGE_SNAPSHOT_2026-08-20.md`.

**NEXT: redeploy auth-service from `main`.** Until it ships nothing emits `is_lateral`, so
`serverKnowsLaterals` stays false and "+ Add lateral channel" stays hidden — correctly. Then the
APK. **NOT device-verified** (founder standing rule).

---

## 0. Audit — what the founder is looking at, and why

| Ask                                                                                                                        | Screenshot                                                            | Implemented?                  | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** "When adding Admins, it should be organization specific only. Admins should not be able to see other organizations." | #1 (Workspaces hub) + #2 (Manage Channels showing GSSG **and** SASFA) | NO — no mechanism exists      | `listOrgChannels` returns `WHERE c.org_id = $1` — the whole TENANT. Inside a workspace tenant an "organisation" is a level-0/1 root CHANNEL (GSSG, SASFA), and nothing scopes a delegated manager to one of them. `org_members.department` is the only scope column and it is free text; the workspace channel form stopped sending `department` at vs2 item 7, so every workspace channel carries `NULL` — the column cannot express this. |
| **B** "This should not be there. Announcements should be within the organization itself."                                  | #2 (`ANNOUNCEMENTS` block, crossed out)                               | HALF                          | Rev 4 §2.4 removed the global heading from the MEMBER directory only. `ManageChannelsScreen`'s stage-1 `ANNOUNCEMENTS` block was kept **deliberately** — §2.4 calls it "the only door to `ChannelEditor`" for parentless legacy broadcasts — and §8 step 7 gates its removal on the purge migration being verified applied. The purge (`20260817000000`) is written but **not applied**, so the block still renders.                        |
| **C** "please add Lateral Channels for each level like on PDF"                                                             | #3 (admin tree shows only `+ Add sub-level`)                          | CODED, HIDDEN                 | `ManageChannelsScreen` gates `onAddLateral` on `serverKnowsLaterals(...)` = "does any row carry an `is_lateral` key". Migration `20260816000000_dept_channel_lateral.sql` is **not applied**, so auth-service cannot emit the field and the D-6 gate correctly hides the button.                                                                                                                                                            |
| **D** "the drop down must not only be on the little arrow, it must be when you click on the whole card/button"             | #3                                                                    | NO — opposite of what shipped | Founder decision **F3** (2026-08-15) was "Chevron expands; the row name opens the chat." This message reverses it.                                                                                                                                                                                                                                                                                                                          |

**Two of the four are deploy gaps, not code gaps.** B and C are blocked on migrations
`20260816000000` and `20260817000000`. They are listed in §5 with the exact commands; the code
changes below are written so the client is CORRECT IN BOTH STATES rather than depending on the
deploy landing first.

---

## 1. Decisions taken (and the ones they overturn)

| #      | Decision                                                                                                                                                                                                                                                                                                                                                                 | Supersedes                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **G1** | **The whole card toggles a level that has something to expand.** The chevron keeps its own 44 dp target and the same action.                                                                                                                                                                                                                                             | **F3** (2026-08-15)                                        |
| **G2** | **No door is lost by G1.** A level row that can be opened gets an explicit open button. On the ADMIN tree the pencil already IS that door (`onEdit` and `onOpen` navigate to the same editor), so admin rows gain nothing. On the MEMBER tree a dedicated open button is added. A level with nothing to expand keeps whole-card-opens — there is no dropdown to give it. | —                                                          |
| **G3** | **A lateral card opens on the whole card.** It has no dropdown, so there is no conflict. Matches the mockups' `>` chevron.                                                                                                                                                                                                                                               | —                                                          |
| **G4** | **Announcements move INTO the organisation instead of being deleted.** A broadcast that has a parent is re-placed as a lateral under that parent, so it draws inside the organisation it belongs to. The global stage-1 `ANNOUNCEMENTS` heading goes. A broadcast with NO parent has no organisation to move into and keeps a door under a plainly-legacy heading.       | Rev 4 §2.4 (renderer-only), §8 step 7 (gated on the purge) |
| **G5** | **Admin org scope is DERIVED from seeded membership, not from a new column.** The server reports which organisation roots the calling manager actually belongs to; the client scopes the admin surfaces to them. No migration, additive response field, safe in both compat directions.                                                                                  | —                                                          |
| **G6** | **A manager invite must name a team on the workspace tenant.** "Whole workspace (all organisations)" stops being reachable for `role = manager`. That is the literal "adding Admins … organization specific only".                                                                                                                                                       | —                                                          |

### Rejected, with reasons — do not re-propose

- **A new `org_members.org_scope_channel_id` column.** It is the textbook answer and it is wrong
  here: `listOrgChannels` and `listChannels` both `SELECT` their columns literally, and Rev 4 §8
  documents what happens when the service reads a column the DB lacks — `42703 undefined_column`,
  a 500 on the member directory, Manage Channels, the home dashboard, the vault shelf, the ops
  departments table, the invite picker and `createChannel`. **The whole module, down.** A
  migration that cannot be applied from this session must not become a hard dependency of a
  client ship.
- **Changing `placeRow` globally so every broadcast nests.** Rev 4 §2.4 rejected this for AGENCY
  members, whose per-level broadcast is parented to an arbitrary node while every member is seeded
  into it — nesting it demotes their guaranteed announcements door to a "(not shown)" rung. G4
  therefore re-places broadcasts **at the workspace-tenant call sites only** (verified below), and
  `placeRow` itself is untouched.
- **Deleting the stage-1 announcements block outright.** Rev 4 §8's "aborted-purge branch" says it
  plainly: with the block gone and the purge not verified, live broadcast rows have **no admin
  door at all**. G4 gives them a better one first.
- **Making the level row toggle-only on the member tree.** Rev 4 §2.6 records two attempts at
  moving the level's own thread elsewhere; each lost a door for unprovisioned nodes. G2 keeps it.

### Verified before choosing G4 — every consumer of the tree helpers

| Consumer                           | Path                                                          | Affected by G4?                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ManageChannelsScreen` stage 1 + 2 | `orgFirst = isWorkspace && serverKnowsTree`                   | **Workspace only.** Agencies take the `treeOrder` branch, which reads `parent_id` directly and never calls `placeRow`. |
| `DepartmentChannelsScreen`         | `orgFirst = isWorkspace`                                      | **Workspace only.** Agencies take the `LEVELS` branch, which groups by `c.level`.                                      |
| `InviteMemberScreen`               | `pickable = rows.filter(r => !r.is_broadcast && !r.archived)` | **No** — broadcasts are stripped before every tree call.                                                               |
| `ApprovalsScreen`                  | imports `WHOLE_WORKSPACE_LABEL` only                          | **No.**                                                                                                                |
| `orgDisambiguation.ts`             | name/id helpers                                               | **No.**                                                                                                                |

---

## 2. Work items

### W1 — `ChannelTree`: whole-card dropdown (G1/G2/G3)

`src/screens/deptchat/ChannelTree.tsx`

1. The row container becomes a `TouchableOpacity`. Its `onPress` is
   `expandable && isLevel ? toggle : open`, and it is `disabled` when neither is available.
2. `accessibilityRole="button"`, `accessibilityState={{expanded}}` on an expandable level, and a
   label that states which action the card performs (`Expand X, level 2` / `Collapse X, level 2` /
   `Open X`).
3. The chevron stays as its own button with the same action — a second target, never a competing
   one.
4. **New:** an open button on a level row that is BOTH expandable and openable and is NOT in admin
   mode (admin's pencil already covers it).
5. Laterals: whole card opens; no chevron button, keep the static `>`.

### W2 — announcements inside the organisation (G4/B)

`src/screens/deptchat/organisationTree.ts` — new exported helper, nothing existing changes:

```ts
export function nestParentedBroadcasts(rows: readonly TreeRow[]): TreeRow[];
```

Returns the same rows with every `is_broadcast` row that HAS a `parent_id` present in the list
re-marked `{is_broadcast: false, is_lateral: true, announcement: true}`. `announcement` is a new
optional display-only field on `TreeRow` so `ChannelTree` keeps drawing the announcement glyph.

- `ManageChannelsScreen`: feed `treeRows` through it — parented broadcasts appear as neutral
  laterals under their level, inside their organisation, and `orgCounts` counts them.
- `DepartmentChannelsScreen`: same, so the member sees announcements under the level that owns
  them instead of in a root-level pile at the bottom.
- Stage-1 `ANNOUNCEMENTS` block: now lists ONLY parentless broadcasts, and its heading becomes
  `UNPLACED ANNOUNCEMENTS` with the subtitle stating it belongs to no organisation. On a purged
  or clean workspace the array is empty and nothing renders — which is the founder's screenshot,
  fixed, without stranding a row on a workspace where the purge has not run.

### W3 — laterals at every level (C)

The affordance is already correct. Two things:

1. **Deploy** `20260816000000_dept_channel_lateral.sql` (§5). Without it the D-6 gate is right to
   hide the button and no client change can honestly reveal it.
2. Keep `+ Add lateral channel` / `+ Add sub-level` hidden while a level is collapsed (Rev 4's
   reasoning stands), but with G1 an admin can now collapse a level by tapping its name — so the
   expanded/collapsed state must be announced on the card's own a11y label.

### W4 — admin organisation scope (G5/A)

**Server** — `apps/auth-service/src/department/department.service.ts`, `listOrgChannels`:

Add `manager_scope_root_ids: string[] | null` to the response.

- `null` = unscoped (the whole tenant), which is today's behaviour exactly.
- The owner / company account (`managerUserId === orgUserId`) is always `null`.
- Non-workspace (agency) tenants are always `null` — agencies are branch-scoped by `department`
  and this scope must not touch them.
- Otherwise: the distinct ROOT ids of every live channel the caller holds a
  `department_channel_members` row for, walked up `parent_id` with a recursive CTE.
- **Fail-open:** an empty set emits `null`, not `[]`. A manager with no seeded membership must not
  be locked out of a screen they can reach today; narrowing is the safe direction, blanking is not.

**Client** — `ManageChannelsScreen`:

- Stage 1 lists only organisations in `manager_scope_root_ids` when it is a non-empty array.
- `Create new organisation` is hidden when scoped — a scoped admin is, by the founder's sentence,
  organisation-specific.
- Absent field (old server) means `undefined`, i.e. today's behaviour.

**Client** — `InviteMemberScreen` (G6):

- On the workspace tenant, `role = manager` makes the team selection REQUIRED; the
  `WHOLE_WORKSPACE_LABEL` escape hatch is disabled for that role with copy saying why.
- The picker is fed by the same endpoint, so a scoped admin can only pick inside their own
  organisation — the "cannot see other organizations" half falls out of W4's server change.

### W5 — tests

| Suite                                   | Adds                                                                                                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channelTreeInteraction.test.tsx` (new) | whole-card toggle; the chevron still toggles; a level with nothing to expand still OPENS on the card; a lateral opens on the card; the member tree keeps an open door on an expandable level; the admin tree's pencil is that door             |
| `channelTreeModel.test.ts`              | `nestParentedBroadcasts`: a parented broadcast becomes a lateral under its parent; a PARENTLESS one is untouched; a broadcast whose parent is not in the list is untouched; idempotent                                                         |
| `manageChannelsOrgScoped.test.tsx`      | no global `ANNOUNCEMENTS` heading; a parented broadcast is reachable INSIDE its organisation; a parentless one keeps its door; scope list hides other organisations and the create-organisation card; absent scope leaves everything unchanged |
| `inviteTeamPicker.test.tsx`             | a manager invite cannot submit with no team on the workspace tenant; an employee invite still can                                                                                                                                              |
| `departmentDirectoryRender.test.tsx`    | member tree: whole-card toggle + the new open button                                                                                                                                                                                           |
| `department.service.spec.ts` (auth)     | `manager_scope_root_ids`: null for the owner, null for an agency, the root set for a delegated manager, null (not `[]`) when empty                                                                                                             |

---

## 3. Regression risk register

| Risk                                                   | Guard                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Nested touchables swallow the chevron press            | Explicit test that the chevron alone toggles                                                                             |
| G1 removes the member's door to a level's chat         | W1.4 open button + a test that presses it                                                                                |
| G4 changes agency behaviour                            | Call sites are workspace-only (§1 table); `placeRow` untouched; agency test kept                                         |
| W4 hides an organisation an admin legitimately manages | Fail-open on empty; owner always unscoped; field absent means unchanged                                                  |
| G6 blocks a legitimate org-wide manager invite         | Applies to the WORKSPACE tenant only; the owner still invites org-wide by leaving role = employee, and can promote later |
| Broadcast rows double-render (tree + section)          | The section's source becomes "parentless only" — disjoint by construction; asserted                                      |

---

## 4. Gates

```bash
npx jest --selectProjects app --testPathPattern "deptchat|screens/messenger"
npx jest --selectProjects messenger-crypto            # twice (B-126 flake rule)
cd apps/auth-service && npm test
npm run typecheck                                     # must not exceed .tsc-baseline.json
npm run lint
```

## 5. Deploy prerequisites — THESE ARE THE REAL BLOCKERS FOR B AND C

```bash
# 1. lateral support — provably a no-op (every row defaults is_lateral = FALSE)
psql "$DATABASE_URL" -f supabase/migrations/20260816000000_dept_channel_lateral.sql
# 2. deploy auth-service (it already SELECTs is_lateral — the migration MUST land first)
# 3. snapshot, then the guarded purge (NOT --single-transaction; the file opens its own txn)
psql "$DATABASE_URL" -f supabase/migrations/20260817000000_purge_legacy_workspace_broadcasts.sql
```

Until step 1 lands, `+ Add lateral channel` stays hidden by design (D-6: an old server silently
strips `lateral: true` and creates a permanently-wrong structural child).
