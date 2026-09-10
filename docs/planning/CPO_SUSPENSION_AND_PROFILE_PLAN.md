# CPO Suspension Window · Officer Profile · Org Hierarchy — Implementation Plan

**Branch:** `fix/messenger-audit-b121` (THE working branch — do not switch)
**Date:** 2026-07-23 · **Revision 2** (owner corrections applied)
**Status:** PLAN — implement from this document.

---

## 0. Owner decisions (revision 2 — these override revision 1)

| #   | Decision                                                          | Effect on plan                                                                         |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D1  | **Keep** session revoke + channel strip + key rotation on suspend | ✅ **No security control is weakened.** Revision 1's §1 concern is withdrawn entirely. |
| D2  | Suspension **reason is mandatory**                                | Manager must type a reason; server rejects empty.                                      |
| D3  | Suspended CPO sees the reason **at login**                        | Surface on the existing `AccessEndedScreen`.                                           |
| D4  | **Suspend is BLOCKED while on a live mission**                    | Reverses rev-1 Q1. Server + client both enforce.                                       |
| D5  | Managers may suspend; **only the owner may promote**              | Unchanged from today's behaviour.                                                      |
| D6  | UTC stored, local rendered                                        | Unchanged.                                                                             |
| D7  | **New:** org hierarchy graph screen                               | New §6.                                                                                |

---

## 1. What already exists (verified in code — do NOT rebuild)

| Ask                                           | Status         | Evidence                                                                                             |
| --------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Suspended CPO hidden from assign-a-CPO picker | ✅ **DONE**    | `src/screens/agent/OrgMissionsScreen.tsx:236` — `roster.filter(m => m.status === 'active')`          |
| Server refuses to crew a non-active member    | ✅ **DONE**    | `apps/auth-service/src/org/org-mission.service.ts:366`                                               |
| Suspended CPO is locked out of the app        | ✅ **DONE**    | `CpoSessionGuard` → `agency_access_ended`; `authStore.ts:626`; `resolveRoute.ts:40` → `access-ended` |
| A dedicated "access ended" screen exists      | ✅ **DONE**    | `src/screens/cpo/AccessEndedScreen.tsx` — **but shows no reason**                                    |
| CPO can upload a profile picture              | ✅ **DONE**    | `useAvatarPicker.ts` → Supabase `avatars` bucket; wired `CpoNavigator.tsx:132`                       |
| In-app popup design system                    | ✅ **DONE**    | `BravoAlertHost.tsx` already replaces every native alert (B-88)                                      |
| Mission history + "was he the leader"         | ✅ **DONE**    | `OrgCpoMissionsScreen.tsx:146` renders `★ Lead` from `is_lead`                                       |
| Reinstate action                              | ⚠️ **PARTIAL** | Exists (`OrgRosterScreen.tsx:181`) — **no confirmation**                                             |

**Net new work:** suspension _window_ + _mandatory reason_, reason-at-login, mission-lock, confirmations, full profile page, org hierarchy graph.

---

## 2. Migration

**New file:** `supabase/migrations/20260723120000_org_member_suspension_window.sql`

```sql
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS suspended_from  timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_until timestamptz,
  ADD COLUMN IF NOT EXISTS suspend_reason  text,
  ADD COLUMN IF NOT EXISTS suspended_by    uuid REFERENCES public.users(id);

CREATE INDEX IF NOT EXISTS org_members_suspension_expiry_idx
  ON public.org_members (org_user_id, suspended_until)
  WHERE status = 'suspended' AND suspended_until IS NOT NULL;
```

`suspended_until IS NULL` = indefinite (today's behaviour preserved). Apply via **Supabase MCP** per `loop.md`.

---

## 3. Backend — `apps/auth-service`

### 3.1 `setMemberStatus` — extend, do not rewrite

**File:** `src/org/org-cpo.service.ts:520-553`

```ts
async setMemberStatus(
  orgUserId, memberUserId, status, actorId?,
  window?: {from?: string|null; until?: string|null; reason?: string|null},
): Promise<void>
```

**Keep every existing side-effect exactly as-is** (D1): `revokeAllUserSessions` + `syncMemberToOrgChannels('remove')` on suspend AND remove; re-add on active.

New behaviour only:

- **D2 — reason required:** `status === 'suspended'` with blank/missing `reason` → `BadRequestException('suspend_reason_required')`.
- **D4 — mission lock:** before any write, when `status` is `suspended` **or** `removed`, check the member's live-mission flag; if on a mission → `BadRequestException('member_on_live_mission')`. Reuse the `on_mission` SQL already at `org-cpo.service.ts:351` — extract it into a private `isOnLiveMission(orgUserId, memberUserId)` rather than hand-copying the predicate (this repo's recurring failure mode is _one behaviour, N hand-copied impls, the unwatched copy drifts_).
- Write `suspended_from` (default `now()`), `suspended_until`, `suspend_reason`, `suspended_by = actorId`.
- Clear all four columns on `active` / `removed`.
- Validation: `until` valid ISO, strictly after `from`, ≤ **365 days**; `reason` ≤ 280 chars.
- Audit metadata gains `{from, until, reason}`.

> **Why `removed` is also mission-locked:** revision 1 §10 flagged that removing mid-mission kills the officer's session while they are physically on a detail. The owner asked to "fix all the thing", and `removed` is strictly more destructive than `suspend`. Blocking both.

### 3.2 Lazy expiry sweep

**File:** `src/org/org-cpo.service.ts` — new private helper.

Because suspension **strips channels and rotates keys** (D1), expiry is **not** a bare status flip — it must run the same restore path as a manual reinstate:

```ts
private async expireLapsedSuspensions(orgUserId: string): Promise<void> {
  const due = await this.db.q<{member_user_id: string}>(
    `SELECT member_user_id FROM org_members
      WHERE org_user_id = $1 AND status = 'suspended'
        AND suspended_until IS NOT NULL AND suspended_until <= now()`,
    [orgUserId],
  );
  for (const m of due) {
    // Reuse the reinstate path — clears the window AND re-adds channels.
    await this.setMemberStatus(orgUserId, m.member_user_id, 'active', orgUserId);
  }
}
```

Call from `listRoster()`, `getMemberProfile()` and `getOrgHierarchy()`. No cron — no missed-tick window, no new infra.

> **Deviation from rev-2 (decided during implementation):** `assignCrew()` does **not** sweep.
> It lives in `OrgMissionService`, which does not inject `OrgCpoService`, and adding that
> injection risks a DI cycle (`OrgCpoService` → `DepartmentService`/`AuthService`). Copying the
> sweep SQL there would be a second hand-maintained impl — the exact drift pattern this repo
> keeps getting bitten by. **Accepted gap:** an expired suspension not yet swept fails
> `assignCrew` with `cpo_not_in_org`. That is a _safe-deny_, and every real assignment is
> preceded by a roster read that does sweep. Revisit only if it is seen in practice.

### 3.3 Reason at login (D3)

**File:** `src/auth/account-kind.ts`

`ACCOUNT_KIND_SQL` already selects `om.status AS member_status`. Add:

```sql
om.suspend_reason  AS suspend_reason,
om.suspended_until AS suspended_until,
```

…to both the `SELECT` and the `LATERAL` subquery, then pass through `deriveAccountKind` into `AccountKindResult` as `suspension: {reason, until} | null` (non-null only when `member_status === 'suspended'`).

`/auth/me` already returns `membership_status` (`auth.service.ts` getMe); add `suspension` alongside it. **Do not** put it in the JWT — auth-token stop-condition; it is re-read per request exactly like the rest of the discriminator.

`CpoSessionGuard` stays **unchanged** — it must keep throwing `agency_access_ended`. The reason travels via `/auth/me`, which is deliberately not gated by that guard.

### 3.4 New endpoint — officer profile

`GET /org/cpos/:memberUserId/profile` in `src/org/org.controller.ts`, org-scoped + IDOR-gated like the existing `cpos/:id/missions`. One aggregate so the screen makes one call:

```
member_user_id, display_name, email, phone_e164, avatar_url, call_sign,
member_role, status, agent_status, armed_authorized, on_duty, on_mission,
suspended_from, suspended_until, suspend_reason, suspended_by_name, created_at,
stats: {missions_total, missions_completed, missions_aborted, missions_led,
        total_distance_m, total_duration_s, credits_earned}
```

`missions_led = COUNT(*) FILTER (WHERE is_lead)`.

### 3.5 New endpoint — org hierarchy (D7)

`GET /org/hierarchy` in `src/org/org.controller.ts`.

**`org_members` has no `reports_to` column** (verified: `20260610000000_provider_orgs_and_managed_cpos.sql:22-35`), so the hierarchy is a **role tier**, not a reporting chain:

```
        [ OWNER ]  ← the company account (users.display_name + email)
             │
   ┌─────────┴─────────┐
[MANAGER] [MANAGER] …          ← org_members.member_role = 'manager'
             │
   ┌─────────┴─────────┐
 [CPO] [CPO] [EMPLOYEE] …      ← member_role = 'cpo' | 'employee'
```

Returns flat, client renders the tree:

```ts
{
  owner: {user_id, display_name, email, avatar_url, position: 'Owner'},
  managers: Node[],   // position: 'Manager'
  members:  Node[],   // position: 'CPO' | 'Employee'
}
// Node = {user_id, display_name, email, avatar_url, position, status, call_sign}
```

Exclude `status='removed'`. Include suspended (rendered dimmed) so the chart is the truth.

### 3.6 DTO

`src/org/dto/org.dto.ts` — `SetMemberStatusDto` gains `suspended_from?`, `suspended_until?` (`@IsOptional() @IsISO8601()`), `suspend_reason?` (`@MaxLength(280)`).

---

## 4. Mobile — suspension flow

### 4.1 New: `src/components/SuspendMemberModal.tsx`

`Alert.alert` cannot host a date picker or a text input, so this is a purpose-built modal **matching** `BravoAlertHost`.

**Extract the shared tokens** from `BravoAlertHost.tsx` into `src/components/ui/dialogTokens.ts` (`CARD_GRADIENT ['#131A28','#0C111B']`, `FILL_GRADIENT ['#4C86F0','#2F5BE0']`, 22px radius, 44px medallion, backdrop `rgba(4,6,10,0.72)`, 48px buttons) and import in both. Do **not** hand-copy the palette.

Contents: amber medallion · title `Suspend {name}?` · warning that they will be signed out and lose chat access until it ends · **From** / **Until** date rows (`@react-native-community/datetimepicker` v8.4.4, already a dep — copy the pattern from `src/screens/deptchat/ShiftEditorScreen.tsx`) · **Indefinite** toggle · quick-picks `7 / 14 / 30 days` · **required** reason input (280 cap, submit disabled while empty — D2) · live summary _"14 days · returns 6 Aug"_ · `Cancel` / `Suspend` (destructive).

### 4.2 `src/screens/agent/OrgRosterScreen.tsx`

| Line       | Change                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `:178-179` | Suspend opens `SuspendMemberModal` instead of firing instantly.                                                                                                    |
| `:180-181` | Reinstate gains a confirmation (`Alert.alert('Lift suspension?', …)`).                                                                                             |
| `:175`     | **D4:** when `m.on_mission`, render Suspend and Remove **disabled** with subtitle _"Cannot suspend during a live mission — available when the mission completes."_ |
| `:213`     | The `on_mission` string stops being decorative and becomes the reason the actions are blocked.                                                                     |
| `:314-316` | Row tap → new `OrgCpoProfile` screen (was `OrgCpoMissions`).                                                                                                       |
| `:100-107` | `SUSPENDED` pill gains remaining days: `SUSPENDED · 12D`.                                                                                                          |
| `:311`     | Suspended rows dimmed (`opacity 0.55`) + amber hairline + meta line _"Suspended · until 6 Aug"_.                                                                   |
| `:137-144` | Stat strip gains **SUSPENDED** count.                                                                                                                              |
| —          | Group list: active first, then a collapsible **SUSPENDED (n)** section.                                                                                            |
| header     | Add a hierarchy entry point (icon button → `OrgHierarchy`).                                                                                                        |

### 4.3 `src/screens/cpo/AccessEndedScreen.tsx` (D3)

Read `user.suspension` from the auth store; when present render an amber card: _"Your agency has suspended you."_ · the reason verbatim · _"Until 6 Aug 2026"_ (or _"No end date set"_) · a _Contact your agency_ line. When absent (i.e. `removed`), keep today's copy unchanged.

`src/store/authStore.ts` — thread `suspension` through `toUser` alongside `membership_status` (5 call sites: `:204`, `:308`, `:351`, `:625`, `:633`).

---

## 5. Mobile — officer profile

**New:** `src/screens/agent/OrgCpoProfileScreen.tsx` (row-tap destination).

Keep `OrgCpoMissionsScreen.tsx`; **extract its mission card** into `src/components/mission/CpoMissionCard.tsx` and import in both — no duplicated rendering.

Sections: **Hero** (large avatar w/ initials fallback, name, call sign, role badge, status pill, live duty dot) · **Suspension banner** when suspended (from → until, days left, reason, who suspended, **Lift suspension** button + confirm) · **Stats grid** (completed · led · aborted · distance · time · credits) · **Identity** (email, phone, member since, id) · **Compliance** (agent status, armed-authorised, licence) · **Mission history** (`★ Lead` preserved) · **Actions footer** (Suspend / Promote / Remove, same gating as the roster sheet).

Avatar is **read-only** here — only the CPO changes their own (already works). Adding agency-side upload would need a new privileged path and was not requested.

---

## 6. Mobile — org hierarchy graph (D7)

**New:** `src/screens/agent/OrgHierarchyScreen.tsx`

- Vertical tiered tree: Owner → Managers → CPOs/Employees, with connector lines drawn as plain `View`s (1px hairlines) — **no new charting dependency**.
- **Node** = circular avatar (`avatar_url`, initials fallback) + name beneath + a small role-tinted ring (owner cobalt / manager accent-soft / CPO neutral / suspended amber+dimmed).
- Horizontally scrollable tier rows; pinch-zoom is **out of scope** (a `ScrollView` both axes is enough and avoids a gesture dependency).
- **Tap a node** → `BravoAlertHost`-styled detail popup: avatar, name, **email**, **position** (Owner / Manager / CPO / Employee), call sign, status. For a roster member the popup offers _View full profile_ → `OrgCpoProfile`.
- Reachable from the roster header and the agency dashboard.

---

## 7. Wiring

- `src/navigation/types.ts` — add `OrgCpoProfile: {memberUserId: string; displayName: string|null}` and `OrgHierarchy: undefined` to `AgentStackParamList`; register both in the agent navigator.
- `src/services/api.ts` — extend `RosterMember` with `suspended_from`, `suspended_until`, `suspend_reason`, `avatar_url`; add `getMemberProfile(id)`, `getOrgHierarchy()`; extend `setCpoStatus` with the window payload.

---

## 8. Tests

| File                                                          | Covers                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org-cpo.service.spec.ts` (extend)                            | reason required; window validation (`until<=from`, >365d); **suspend blocked when on mission**; **remove blocked when on mission**; session-revoke + channel-strip still fire (regression on D1); expiry sweep restores channels |
| `org-mission.service.spec.ts` (extend)                        | suspended → `cpo_not_in_org`; expired suspension → crewable again                                                                                                                                                                |
| `auth.service.account-kind.spec.ts` (extend)                  | `suspension {reason, until}` surfaces for a suspended CPO; null for active                                                                                                                                                       |
| `src/screens/agent/__tests__/orgRosterSuspend.test.tsx` (new) | Suspend opens modal not instant-fire; Reinstate confirms; on-mission disables both actions                                                                                                                                       |
| `src/components/__tests__/suspendMemberModal.test.tsx` (new)  | quick-picks compute `until`; indefinite clears it; empty reason blocks submit                                                                                                                                                    |
| `src/screens/agent/__tests__/orgHierarchy.test.tsx` (new)     | tiers render; tap → email + position                                                                                                                                                                                             |

Per `CLAUDE.md` §Change safety, write the failing test **first** for the missing confirmation (`:178`) and the mission-lock — both are bug fixes.

---

## 9. Gates

```bash
cd apps/auth-service && npm test          # org + auth specs
npm test -- --selectProjects=booking      # closest existing flow
npm test -- --selectProjects=app          # roster/modal/hierarchy
npm run typecheck                         # ≤ baseline 47
cd apps/ops-console && npm run typecheck
npm run lint
npm test                                  # full, last
```

`docs/runbooks/LITE_BOOKING_LOOP.md` is **triggered** (changes who can be dispatched) — run its §4 gates + B-82 watchlist.
`test:crypto` **is** required: §3.2 expiry re-adds channel members, which touches group-key distribution. **B-126 — it flakes ~50%, so run it twice; one red run is not evidence.**

---

## 10. Build & deploy

1. Apply migration via Supabase MCP; verify columns.
2. Deploy `auth-service` to Contabo — ⚠️ CI deploy never fires (missing `CONTABO_SSH_KEY`); **manual tar-over-ssh**.
3. Bump `app.json` → v1.0.124 / vc152.
4. Export `EXPO_PUBLIC_*` from `package.json` `apk:staging` **first**, then `cd android && ./gradlew assembleRelease`. ⚠️ Raw gradlew ships the wrong backend.
5. Install to `127.0.0.1:5555` (Pie64), `127.0.0.1:5556` (Rvc64), `043dd12e3dad` (Redmi Note 11).
6. Launch + device-verify.

---

## 11. Order of work

1. Migration
2. `setMemberStatus` — reason + window + mission lock (§3.1) + `isOnLiveMission` extraction
3. Expiry sweep (§3.2)
4. Reason through `account-kind` → `/auth/me` (§3.3)
5. Profile + hierarchy endpoints (§3.4, §3.5) + DTO
6. Backend tests
7. `dialogTokens.ts` + `SuspendMemberModal` (§4.1)
8. `OrgRosterScreen` (§4.2)
9. `AccessEndedScreen` + authStore threading (§4.3)
10. `OrgCpoProfileScreen` + mission-card extraction (§5)
11. `OrgHierarchyScreen` (§6)
12. Wiring (§7) → mobile tests (§8)
13. Gates (§9) → build → deploy → device-verify (§10)

---

## 12. Residual risks

| Risk                                                                                | Mitigation                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Mission lock could **trap** an org whose CPO is stuck on a never-completing mission | Error names the mission; ops can complete/abort it. Consider an owner-only override later — **not** in this scope. |
| `ACCOUNT_KIND_SQL` is hot (every guarded request)                                   | Two extra columns from an already-joined row; no new join.                                                         |
| Expiry sweep re-adds channels ⇒ group-key traffic                                   | Sweep is org-scoped + indexed; only fires for genuinely lapsed rows, then the row no longer matches. Idempotent.   |
| Hierarchy on a 10-CPO cap                                                           | Trivial size; no virtualisation needed.                                                                            |
