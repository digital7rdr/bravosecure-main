import type {DatabaseService} from '../database/database.service';
import {activeEnterpriseSql} from '../common/guards/tier.guard';

/**
 * Server-authoritative role discriminator (§35A). Bravo is one binary, three
 * app experiences; the experience is chosen at login from the server's
 * authenticated identity, NEVER from a client-chosen flag and NEVER from a JWT
 * claim. Both AuthService.getMe and CpoSessionGuard resolve it here so there is
 * a single source of truth, re-read from the DB every request.
 */
export type AccountKind = 'individual' | 'agency' | 'cpo';

export interface AccountKindRow {
  user_role: string;
  agent_type: string | null;
  agent_status: string | null;
  managed_by_org_id: string | null;
  member_role: string | null;
  member_status: string | null;
  org_user_id: string | null;
  org_name: string | null;
  password_set_at: Date | null;
  suspend_reason?: string | null;
  suspended_until?: Date | string | null;
  // Scope v2 Phase 6 — the Enterprise workspace owner. `user_id` is needed
  // because an owner IS their own org, so the org id has to come from the row
  // itself rather than from a membership or an agent.
  user_id?: string | null;
  owns_workspace?: boolean | null;
  org_is_workspace?: boolean | null;
  workspace_name?: string | null;
  // Phase B — membership-org facts (see the SQL comment): tenant type of the
  // om org and its display name, for the primary-org precedence + the
  // workspaces array.
  member_org_is_workspace?: boolean | null;
  member_org_name?: string | null;
}

/** Phase B — one enterable workspace affiliation, for the client hub. */
export interface WorkspaceAffiliation {
  org_id: string;
  name: string;
  role: 'owner' | 'manager' | 'employee' | 'cpo';
}

/** Why the member is locked out, shown on the CPO's AccessEndedScreen. */
export interface SuspensionInfo {
  reason: string | null;
  until: string | null;
}

export interface AccountKindResult {
  account_kind: AccountKind;
  org: {id: string; name: string} | null;
  must_set_password: boolean;
  membership_status: string | null;
  // Non-null ONLY while membership_status === 'suspended'. Carries the manager's
  // mandatory reason so the locked-out CPO is told why instead of hitting a
  // blank wall. Never a JWT claim — re-read per request like the rest of this.
  suspension: SuspensionInfo | null;
  // True when the user is a CPO whose agent record hasn't cleared onboarding yet
  // (docs not uploaded / submitted / still under review). Drives the client's
  // post-auth switch to the document-upload flow instead of the CPO home — a
  // managed CPO is seeded DOCS_PENDING and must submit a compliance pack first.
  cpo_needs_onboarding: boolean;
  /**
   * Scope v2 Phase 6 — this user OWNS an Enterprise workspace.
   *
   * Carried as its own fact rather than folded into `account_kind`, because a
   * workspace owner is deliberately not an agency: the alternative was to run
   * them through the service-provider funnel, which would have put an Enterprise
   * company in the provider home and the job marketplace.
   *
   * Clients must gate org access on ownership OR membership, never on
   * `account_kind === 'agency'` alone — that arm is the agency product.
   */
  owns_workspace: boolean;
  /**
   * Founder QA 2026-08-08 — the caller's ORG is an ENTERPRISE WORKSPACE (an
   * org_workspaces row exists for it), as opposed to a security agency /
   * provider org. This is the tenant-TYPE fact the client never had: without
   * it every noun helper keyed on "org-affiliated" and the moment a founder
   * created a workspace (or an employee joined one) the UI flipped to the
   * agency vocabulary — "CPO", "CPO roster" — for people who may have nothing
   * to do with bodyguarding. True for the OWNER (their own ws row) and for
   * every member of a workspace org; false for agency orgs and the unaffiliated.
   */
  org_is_workspace: boolean;
  /**
   * Phase B (owner-join) — EVERY workspace affiliation, additive beside the
   * single legacy `org` (which stays the PRIMARY org and keeps its exact
   * pre-Phase-B value for every pre-existing persona). Today at most two
   * entries are possible: the caller's own active workspace and one active
   * membership (the one-active-membership unique index still stands — Phase B
   * removed only the OWNER refusals). The client hub renders this list.
   */
  workspaces: WorkspaceAffiliation[];
  /**
   * B-417 — this user IS an ACTIVE agency company account (the org itself).
   *
   * A direct fact, mirroring OrgManagerGuard Path 1 (`type='company' AND
   * status='ACTIVE'`) so the client fact and the server admission can never
   * disagree. Exists because the client used to INFER ownership from
   * `account_kind==='agency' && !org` — a proxy Phase B rotted: an owner who
   * joins another org's workspace gets a non-null `org` from the four-arm
   * fallback and silently lost Ops Room key authority on their own agency.
   * Same medicine as `managed_org` for the manager arm.
   */
  owns_agency: boolean;
}

// Agent statuses that mean "ready to work" — anything else for a CPO means the
// onboarding pack (docs → submit → ops review) is still outstanding.
const CPO_READY_STATUSES = new Set(['ACTIVE', 'APPROVED']);

// Why: a user can belong to more than one org (e.g. an active cpo of org A and
// a manager of org B), which would fan the org_members LEFT JOIN into multiple
// rows and make the discriminator non-deterministic. The LATERAL ... LIMIT 1
// collapses it to the single most-relevant membership — active first, then cpo
// over manager — so the precedence below always sees one membership row.
export const ACCOUNT_KIND_SQL = `
  SELECT
    u.role              AS user_role,
    a.type              AS agent_type,
    a.status            AS agent_status,
    a.managed_by_org_id AS managed_by_org_id,
    om.member_role      AS member_role,
    om.status           AS member_status,
    om.org_user_id      AS org_user_id,
    om.suspend_reason   AS suspend_reason,
    om.suspended_until  AS suspended_until,
    -- THE COMPANY'S NAME, NOT THE FOUNDER'S.
    --
    -- org.display_name is the OWNER USER's display name — 'QA Owner', a
    -- person. Every employee of every workspace was shown that as their
    -- company, and resolveReferralLink showed it to APPLICANTS too, so people
    -- were invited to join a company identified by the founder's personal name.
    -- Wrong, and a mild privacy leak.
    --
    -- orgws (below) joins the workspace of the ORG, not of the caller — the
    -- pre-existing ws join is ws.owner_user_id = u.id, i.e. the caller's own
    -- workspace, which is NULL for every employee. That is why the
    -- ?? workspace_name fallback in deriveAccountKind never fired for them.
    COALESCE(orgws.name, org.display_name) AS org_name,
    u.id                AS user_id,
    u.password_set_at   AS password_set_at,
    -- Scope v2 Phase 6: an Enterprise workspace OWNER.
    --
    -- They are deliberately NOT an agency (no agents row, no service_provider
    -- role), so every account_kind arm below reports 'individual' for them —
    -- correctly. The fact that they own a workspace therefore has to travel on
    -- its own, or every gate that asks "are you in an org?" answers no for the
    -- person who just created one.
    -- LAPSE-AWARE, matching OrgManagerGuard's owner arm exactly. If this said
    -- only "a row exists", a lapsed owner would keep the Enterprise client
    -- surface while the server refused every manager route — the client and the
    -- server disagreeing about the same person, with employees inside the
    -- workspace. NULL expiry = permanent comp grant (RS-17).
    (ws.owner_user_id IS NOT NULL
     AND ${activeEnterpriseSql('u')}) AS owns_workspace,
    -- Tenant TYPE of the caller's ORG. When they belong to (or manage under)
    -- an org, THAT org decides — a personal workspace must not flip agency
    -- surfaces to "Member" wording for an agency crew member who happens to
    -- own one (critic LOW-5). With no org, their own workspace stands in
    -- (the owner-before-first-hire persona). Deliberately NOT lapse-gated:
    -- vocabulary must not snap to "CPO" the day a subscription lapses —
    -- feature access is gated elsewhere.
    (CASE WHEN COALESCE(a.managed_by_org_id,
                        CASE WHEN om.org_user_id IS NOT NULL AND omws.owner_user_id IS NULL THEN om.org_user_id END,
                        CASE WHEN ws.owner_user_id IS NOT NULL AND ${activeEnterpriseSql('u')} THEN u.id END,
                        om.org_user_id) IS NOT NULL
          THEN orgws.owner_user_id IS NOT NULL
          ELSE ws.owner_user_id IS NOT NULL END) AS org_is_workspace,
    ws.name             AS workspace_name,
    -- Phase B (owner-join, founder-approved 2026-08-09) — facts about the
    -- MEMBERSHIP org, independent of which org wins the primary resolution:
    -- the tenant type discriminates the two owner+member personas (an agency
    -- crew member who owns a personal workspace keeps resolving to the AGENCY
    -- — critic LOW-5 — while an owner who joined another WORKSPACE keeps
    -- resolving to their OWN), and the name feeds the workspaces array (the
    -- primary org joins below resolve the PRIMARY org's name, which for an
    -- owner is their own workspace, not the joined one).
    (omws.owner_user_id IS NOT NULL) AS member_org_is_workspace,
    COALESCE(omws.name, omu.display_name) AS member_org_name
  FROM public.users u
  LEFT JOIN agents a ON a.user_id = u.id
  LEFT JOIN LATERAL (
    SELECT member_role, status, org_user_id, suspend_reason, suspended_until
      FROM org_members
     WHERE member_user_id = u.id
     -- managed-CPO revocation: prefer the membership tying the user to their own
     -- managing org (a.managed_by_org_id) so membership_status reflects THAT org
     -- — else a CPO suspended in org A but an active manager of org B would read
     -- 'active' and slip past CpoSessionGuard. Then active-first, then cpo.
     -- vs2 item 4: created_at ASC is the LAST resort, and it matters now.
     -- An employee of Acme who also manages Borealis ties on all three keys
     -- above (managed_by_org_id NULL for both, both active, neither cpo), so
     -- Postgres returned whichever row it liked — and org, org_name,
     -- org_is_workspace and membership_status FLAPPED between requests.
     -- This is the widest-blast-radius query in the service; the other five
     -- resolvers were ordered and this one was missed.
     ORDER BY (org_user_id = a.managed_by_org_id) DESC, (status = 'active') DESC, (member_role = 'cpo') DESC,
              created_at ASC
     LIMIT 1
  ) om ON true
  LEFT JOIN public.org_workspaces ws ON ws.owner_user_id = u.id
  -- Phase B — the membership org's workspace row + owner user, joined BEFORE
  -- the primary-org joins because the resolved-org expression reads them.
  LEFT JOIN public.org_workspaces omws ON omws.owner_user_id = om.org_user_id
  LEFT JOIN public.users omu ON omu.id = om.org_user_id
  -- Phase B — the PRIMARY org, resolved by the four-arm precedence:
  -- managed org > agency membership > own active workspace > workspace
  -- membership. Equivalent to the old two-arm COALESCE(managed, om) for
  -- every persona EXCEPT ws-owner + ws-member. The owner-JOIN direction was
  -- refused pre-Phase-B, but the reverse (workspace member who then CREATED
  -- their own — createWorkspace never checked membership) was reachable:
  -- for that rare persona the primary org DELIBERATELY flips from the
  -- joined workspace to their own on deploy — the intended Discord
  -- semantic (your own workspace is home; the joined one is a hub tile).
  -- Agency crews keep the agency (arm 2, critic LOW-5).
  LEFT JOIN public.users org
         ON org.id = COALESCE(a.managed_by_org_id,
                              CASE WHEN om.org_user_id IS NOT NULL AND omws.owner_user_id IS NULL THEN om.org_user_id END,
                              CASE WHEN ws.owner_user_id IS NOT NULL AND ${activeEnterpriseSql('u')} THEN u.id END,
                              om.org_user_id)
  -- The workspace of the resolved PRIMARY org (distinct from ws, which is the
  -- caller's OWN workspace and drives owns_workspace).
  LEFT JOIN public.org_workspaces orgws
         ON orgws.owner_user_id = COALESCE(a.managed_by_org_id,
                              CASE WHEN om.org_user_id IS NOT NULL AND omws.owner_user_id IS NULL THEN om.org_user_id END,
                              CASE WHEN ws.owner_user_id IS NOT NULL AND ${activeEnterpriseSql('u')} THEN u.id END,
                              om.org_user_id)
  WHERE u.id = $1 AND u.deleted_at IS NULL
`;

/**
 * Pure precedence logic (§35A discriminator). A SUSPENDED/REMOVED managed CPO
 * still resolves to `cpo` via its agents row — so CpoSessionGuard can catch and
 * eject it — rather than silently downgrading to `individual` (which would let
 * a revoked guard slip past the guard).
 */
/**
 * vs2 item 4 — every active membership of a WORKSPACE org, oldest first.
 *
 * Deliberately its own query rather than more columns on ACCOUNT_KIND_SQL: that
 * statement's `LEFT JOIN LATERAL ... LIMIT 1` exists to collapse the caller to
 * ONE discriminating membership, which is exactly what `account_kind` needs and
 * exactly what a switcher must not have.
 */
export const WORKSPACE_AFFILIATIONS_SQL = `
  -- THE COMPANY'S NAME, NOT THE FOUNDER'S — the same rule ACCOUNT_KIND_SQL
  -- states above, and which this query regressed by selecting the owner's
  -- display_name directly. Every membership tile in the hub read 'QA Owner'
  -- instead of 'Borealis Ltd', on the one screen this feature exists to draw,
  -- and rendered EMPTY when the owner had no display_name.
  SELECT om.org_user_id, om.member_role, COALESCE(w.name, u.display_name) AS org_name
    FROM public.org_members om
    JOIN public.users u ON u.id = om.org_user_id
    JOIN public.org_workspaces w ON w.owner_user_id = om.org_user_id
   WHERE om.member_user_id = $1
     AND om.status = 'active'
     AND om.org_user_id <> $1
     AND u.deleted_at IS NULL
     -- LAPSE-AWARE, like every other workspace arm. An ungated list would keep
     -- offering a tile for a workspace whose Enterprise subscription ended:
     -- DepartmentalNavigator reconciles the active context against this array,
     -- so the member would enter a workspace where every manager route 403s and
     -- whose owner has already lost owns_workspace. One subscription, one
     -- answer, on both sides of the switcher.
     AND ${activeEnterpriseSql('u')}
   ORDER BY om.created_at ASC`;

export interface WorkspaceMembershipRow {
  org_user_id: string;
  member_role: string | null;
  org_name: string | null;
}

/**
 * @param memberships ALL active workspace memberships. Omitted, the caller's
 *   workspace list is built from the discriminator row alone — which yields at
 *   most one, and is why the multi-org switcher showed a single tile no matter
 *   how many organisations the user belonged to. Only `resolveAccountKind`
 *   should omit it by accident; the pure-function tests omit it on purpose.
 */
export function deriveAccountKind(
  row: AccountKindRow,
  memberships?: readonly WorkspaceMembershipRow[],
): AccountKindResult {
  const isManagedCpoAgent = row.agent_type === 'cpo' && row.managed_by_org_id !== null;
  const isActiveCpoMember = row.member_role === 'cpo' && row.member_status === 'active';
  const isCompanyAgent    = row.agent_type === 'company';
  const isActiveManager   = row.member_role === 'manager' && row.member_status === 'active';

  let account_kind: AccountKind;
  if (isManagedCpoAgent || isActiveCpoMember) {
    account_kind = 'cpo';
  } else if (isCompanyAgent || isActiveManager) {
    account_kind = 'agency';
  } else {
    account_kind = 'individual';
  }

  // An owner IS their own org — the convention everywhere in this service
  // (org_members.org_user_id, cpo_shifts.org_user_id, and the company agent
  // whose users.id is its own org id). Without the own-workspace arm the person
  // who just created a workspace resolves to org=null and sees an empty one.
  //
  // Phase B — MUST mirror the SQL's four-arm precedence exactly (the org/orgws
  // joins resolve the primary org's NAME with the same expression): managed
  // org > AGENCY membership > own active workspace > WORKSPACE membership.
  // Equivalent to the old chain for every persona except ws-owner+ws-member;
  // for the one such persona reachable pre-Phase-B (member who then CREATED
  // a workspace) the flip to their own workspace is the intended Discord
  // semantic, stated in the SQL comment. Agency crews keep the agency (LOW-5).
  const orgId = row.managed_by_org_id
    ?? (row.org_user_id && !row.member_org_is_workspace ? row.org_user_id : null)
    ?? (row.owns_workspace ? row.user_id : null)
    ?? row.org_user_id;
  const org = orgId
    ? {id: orgId, name: row.org_name ?? row.workspace_name ?? ''}
    : null;
  // Phase B — every enterable workspace affiliation (own + active membership).
  // Only WORKSPACE orgs belong here: the hub is the workspace switcher, and an
  // agency membership is not an enterable workspace tile.
  const workspaces: WorkspaceAffiliation[] = [];
  if (row.owns_workspace && row.user_id) {
    workspaces.push({org_id: row.user_id, name: row.workspace_name ?? '', role: 'owner'});
  }
  const asRole = (r: string | null): WorkspaceAffiliation['role'] =>
    r === 'manager' ? 'manager' : r === 'cpo' ? 'cpo' : 'employee';
  if (memberships) {
    for (const m of memberships) {
      if (m.org_user_id === row.user_id) {continue;}
      workspaces.push({org_id: m.org_user_id, name: m.org_name ?? '', role: asRole(m.member_role)});
    }
  } else if (row.org_user_id && row.member_status === 'active' && row.member_org_is_workspace
      && row.org_user_id !== row.user_id) {
    workspaces.push({org_id: row.org_user_id, name: row.member_org_name ?? '', role: asRole(row.member_role)});
  }

  return {
    account_kind,
    org,
    must_set_password: account_kind === 'cpo' && row.password_set_at === null,
    // A company agent has no org_members row; it is its own active org.
    membership_status: row.member_status ?? (isCompanyAgent ? 'active' : null),
    suspension: row.member_status === 'suspended'
      ? {
        reason: row.suspend_reason ?? null,
        until: row.suspended_until
          ? new Date(row.suspended_until).toISOString()
          : null,
      }
      : null,
    cpo_needs_onboarding:
      account_kind === 'cpo' &&
      row.agent_status !== null &&
      !CPO_READY_STATUSES.has(row.agent_status),
    owns_workspace: !!row.owns_workspace,
    org_is_workspace: !!row.org_is_workspace,
    workspaces,
    // ACTIVE-gated to mirror OrgManagerGuard Path 1 exactly — deliberately
    // STRICTER than isCompanyAgent (which is status-blind for account_kind).
    owns_agency: isCompanyAgent && row.agent_status === 'ACTIVE',
  };
}

/** Re-reads the discriminator from the DB. Safe default for an unknown / soft-
 *  deleted user (no elevated access, no forced reset) — such sessions are
 *  already JTI-revoked by changePassword/deleteSession. */
export async function resolveAccountKind(
  db: Pick<DatabaseService, 'qOne' | 'q'>,
  userId: string,
): Promise<AccountKindResult> {
  const row = await db.qOne<AccountKindRow>(ACCOUNT_KIND_SQL, [userId]);
  if (!row) {
    // Fails CLOSED on every axis, owns_workspace included: an unknown or
    // soft-deleted user owns nothing.
    return {
      account_kind: 'individual', org: null, must_set_password: false,
      membership_status: null, suspension: null, cpo_needs_onboarding: false,
      owns_workspace: false, org_is_workspace: false, workspaces: [],
      owns_agency: false,
    };
  }
  const memberships = await db.q<WorkspaceMembershipRow>(WORKSPACE_AFFILIATIONS_SQL, [userId]);
  return deriveAccountKind(row, memberships);
}

/**
 * Whether the user is a MANAGER of any service-provider org — the canonical rule
 * OrgManagerGuard enforces: a `company` agent (its own org), an Enterprise
 * WORKSPACE OWNER, OR an active `org_members.member_role='manager'` row.
 *
 * ⛔ NOT the subscription tier (F2). This used to carry a fourth arm admitting
 * any ACTIVE enterprise-tier user, mirroring the guard's old Path 3 — so buying
 * the plan flipped `is_org_manager` to true and the client rendered the whole
 * admin surface for someone with `org: null` and no workspace. Frame A4: "Admin
 * selection alone must never create authority." Removed from BOTH sides in the
 * same change: this function exists to PREDICT what OrgManagerGuard admits, so
 * an arm here that the guard does not have is a bug by construction (and vice
 * versa — see the guard's matching note).
 *
 * This is computed SEPARATELY from
 * resolveAccountKind because ACCOUNT_KIND_SQL collapses multi-org membership to a
 * single cpo-preferred row — so a user who is an active CPO of org A AND an active
 * manager of org B reads account_kind='cpo' yet IS an org manager. The mobile app
 * routes its Departmental manager surfaces off this flag (via /auth/me) so the UI
 * matches what OrgManagerGuard authorizes, without changing the cpo precedence.
 */
export async function resolveIsOrgManager(
  db: Pick<DatabaseService, 'qOne'>,
  userId: string,
): Promise<boolean> {
  const row = await db.qOne<{is_company: boolean; is_manager: boolean; is_owner: boolean}>(
    `SELECT
       EXISTS(SELECT 1 FROM agents WHERE user_id = $1 AND type = 'company') AS is_company,
       -- Scope v2 Phase 6 — the Enterprise WORKSPACE OWNER.
       --
       -- They have no agents row (deliberately: the founder chose not to mint
       -- owners through the service-provider funnel) and no org_members row
       -- (ownership lives in its own table), so all three arms below report
       -- false. Without this the person who created the workspace is admitted
       -- INTO it by owns_workspace and then 403s on every manager route —
       -- including the join-approval inbox, i.e. an Enterprise workspace nobody
       -- can administer.
       --
       -- Lapse-aware, mirroring OrgManagerGuard's owner arm — this function
       -- exists to predict what that guard admits, so any divergence between
       -- them is a bug by construction.
       EXISTS(SELECT 1 FROM public.org_workspaces w
               JOIN public.users wu ON wu.id = w.owner_user_id
              WHERE w.owner_user_id = $1
                AND wu.deleted_at IS NULL
                AND ${activeEnterpriseSql('wu')}) AS is_owner,
       -- NO TIER ARM. users.subscription_tier is deliberately not read here:
       -- see the F2 note above. OrgManagerGuard has no tier path either, and
       -- these two must stay identical. (No backticks in this comment: it
       -- lives inside a JS template literal, so one would terminate the SQL.)
       EXISTS(SELECT 1 FROM org_members WHERE member_user_id = $1 AND member_role = 'manager' AND status = 'active') AS is_manager`,
    [userId],
  );
  return !!(row && (row.is_company || row.is_owner || row.is_manager));
}

/** The org a delegated manager manages, plus what its owner granted them. */
export interface ManagerContext {
  managed_org: {id: string; name: string} | null;
  permitted_modules: string[] | null;
}

/**
 * Resolves BOTH manager facts from the SAME org_members row, so they can never
 * disagree: which org this user manages, and which dashboard modules its owner
 * granted them.
 *
 * `managed_org` — not `permitted_modules` — is what identifies a manager.
 * The previous shape overloaded one nullable column with two questions ("is
 * this a manager?" and "what were they granted?"); since the column DEFAULTS
 * to NULL those were indistinguishable, and every fix for one broke the other.
 * Split, an empty grant list means exactly one thing.
 *
 * Structurally null for the OWNER: an owner has no org_members row (their
 * `agents.type` is 'company'), and `org_user_id <> $1` makes that guaranteed
 * rather than incidental. It is also the ONLY correct answer for a user who is
 * a CPO of org A and a manager of org B — ACCOUNT_KIND_SQL collapses that to
 * the CPO row and reports org A, whereas this reads the manager row directly.
 */
export async function resolveManagerContext(
  db: Pick<DatabaseService, 'qOne'>,
  userId: string,
): Promise<ManagerContext> {
  const row = await db.qOne<{org_id: string; org_name: string | null; permitted_modules: string[] | null}>(
    `SELECT om.org_user_id AS org_id, org.display_name AS org_name, om.permitted_modules
       FROM public.org_members om
       JOIN public.users org ON org.id = om.org_user_id
      WHERE om.member_user_id = $1 AND om.member_role = 'manager'
        AND om.status = 'active' AND om.org_user_id <> $1
      -- vs2 item 4: same order as OrgManagerGuard's candidate list. This is the
      -- guard's client-facing twin — chrome and permitted_modules come from
      -- here while every request resolves through the guard. Unordered, the two
      -- could name different orgs, and the pairing could flip between taps.
      ORDER BY om.created_at ASC
      LIMIT 1`,
    [userId],
  );
  if (!row) {return {managed_org: null, permitted_modules: null};}
  // The owner decides absolutely (founder rule): a manager nobody configured
  // (NULL) and one the owner deliberately cleared ([]) are the same thing —
  // no modules. Safe to collapse now only because `managed_org` carries the
  // "is a manager" signal that used to ride on this column's null-ness.
  return {
    managed_org: {id: row.org_id, name: row.org_name ?? ''},
    permitted_modules: row.permitted_modules ?? [],
  };
}
