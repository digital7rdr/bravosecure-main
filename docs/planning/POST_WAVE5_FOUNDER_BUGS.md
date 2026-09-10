# Post-Wave-5 founder bugs (2026-08-21)

Two UI/data bugs the founder reported to fix **after Wave 5** completes, each through the
builder→edge→critic loop with a RED-first regression pin (B-143+ contract).

> **STATUS 2026-08-22 — ALL FIXED, dual-AGREE, committed:** FB-1 = **B-609** (`44d0c856`), FB-2 =
> **B-610** (`836440a4`), both merged to main; FB-2 **deployed to staging + verified**. FB-1 needs an
> **APK** to reach devices. The two founder-approved follow-ups are now **B-611**: (1) the FB-2
> absent-header case broadened — with no org context, `mine`/`myShifts` show ALL the caller's OWN
> reports/shifts (labelled), never an empty list; (2) `AttendanceService.myShifts` given the identical
> org-scoping (`cpo_shift_sessions.org_user_id` NOT NULL + 24/24 populated). Auth-service deploy owed.

## FB-1 — Departmental Channels tree: tap targets are wrong

**Screenshot:** the Channels tree (Service Providers L1 → Movement L2 → Road/Air movement L3 →
Emirates/Etihad L4 → IT L2). Each expandable card shows a `#` icon + a `∨` chevron.

- **Now:** tapping the little `#` icon opens the chat (tiny target); the WHOLE card toggles expand
  (CLAUDE.md G1 / `channelTreeInteraction`).
- **Want:** tapping **anywhere on the card EXCEPT the chevron arrow** opens the chat; tapping **only
  the chevron `∨`** expands/collapses the child branches.
- **Founder clarification (2nd screenshot):** the card already renders a vertical `|` divider just
  LEFT of the chevron — use it as the tap-zone boundary. **Everything left of the `|` (the `L#` badge,
  the `#`, the name/members) = ENTER/open the chat; the chevron area right of the `|` = EXPAND/collapse.**
  So it's a two-hit-slop split within one card, matching the visible divider. (Applies to expandable
  cards; leaf cards with a `>` already just navigate.)
- **Impact:** flips the current interaction model — must update `channelTreeInteraction.test.ts` (G1
  currently pins "whole card toggles expand") + keep G2 (no door lost: admin pencil / member open).
  Find the tree card component under `src/screens/messenger/**` (department directory / channel tree).
  Split the card `Pressable`: a left region (`onPress`=open) + a right chevron `Pressable`/hit-target
  (`onPress`=toggle, `stopPropagation`). Keep both keyed by `testID`, not label (the card is
  `accessible={false}` — G1 trap).
- **Gate:** messenger-folder change → FULL messenger gate (crypto ×2 + app screens/messenger).

## FB-2 — Incident Reports leak across organizations

**Screenshot:** "Incident Reports" / "MY REPORTS" list (Medical Incident, Safety Issue, Security
Concern) reached via Channels → "Attendance & Incidents".

- **Now:** reports filed in DIFFERENT orgs all show in ONE list (mixed).
- **Want:** each report scoped to the org it was filed in — an org's Channels → Incident Reports shows
  ONLY that org's reports.
- **Investigate:** where incident reports are fetched (client screen + the backend endpoint — likely
  `apps/auth-service` or messenger-service; grep incident/report). Is the leak a missing `org_id`
  filter on the query, or a missing `org_id` on the write, or the client not passing the active org?
  Same family as the multi-org scope work ([[item4-multi-org-shipped]], `manager_scope_root_ids`).
- **Gate:** backend scoping change → server spec (RED-first) proving cross-org isolation; if it touches
  a DB query, a data probe. Deploy-owed (auth-service/messenger-service) if backend.
