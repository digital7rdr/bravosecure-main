import {BadRequestException, ConflictException, ForbiddenException, Injectable, Logger} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from './org-audit.service';
import {DepartmentService} from '../department/department.service';
import {activeEnterpriseSql} from '../common/guards/tier.guard';
import {pickOrgContext, pickOrgContextForWrite} from './org-context';

export interface OrgWorkspace {
  owner_user_id: string;
  name: string;
  created_at: string;
}

/**
 * Scope v2 Phase 6 — A5 "Create Org Workspace".
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *
 * It does NOT create an agent, and it does NOT touch `users.role`.
 *
 * The only pre-existing way to become an org owner was `POST /agents` with
 * type='company', which flips the caller to `role='service_provider'`. That is
 * the security-services funnel: it routes the user to the provider home and the
 * job marketplace. An Enterprise company that wants internal department channels
 * is not an agency, so this mints a workspace owner WITHOUT that role grant
 * (owner-decided, 2026-08-04).
 *
 * Consequence worth stating: `account_kind` stays 'individual' for a workspace
 * owner. Anything that gates on account_kind === 'agency' will NOT see them —
 * which is the point. What must see them is "owns a workspace", carried
 * explicitly rather than inferred from a kind.
 */
@Injectable()
export class WorkspaceService {
  private readonly log = new Logger(WorkspaceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OrgAuditService,
    // Phase 6 added a SECOND way to become an org; the workspace seeding that
    // the service-provider funnel has always done has to run here too.
    private readonly department: DepartmentService,
  ) {}

  /**
   * Create the caller's workspace. The caller IS the org, matching the
   * convention everywhere else in this service (`org_members.org_user_id`,
   * `cpo_shifts.org_user_id`), so no new id space is introduced.
   *
   * NOT idempotent-by-silence: a second call CONFLICTS rather than quietly
   * returning the existing row. Creating a workspace is a deliberate act with a
   * name attached — silently ignoring a second name would leave the user
   * looking at a workspace called something they did not type, with no error to
   * explain it.
   */
  async createWorkspace(ownerUserId: string, name: string): Promise<OrgWorkspace> {
    const trimmed = (name ?? '').trim();
    if (!trimmed) {throw new BadRequestException('workspace_name_required');}

    // TIER GATE (owner-decided 2026-08-04). Without it this route is a
    // self-serve way past the paid Enterprise gate: `owns_workspace` is checked
    // FIRST in the client's isOrgAffiliated, so one call would unlock the whole
    // Enterprise surface for any authenticated user, permanently.
    //
    // Lapse-aware in exactly the shape OrgManagerGuard Path 3 uses — NULL
    // expiry is a permanent comp grant (RS-17), not "expired". Written the same
    // way deliberately: this predicate and the guard's must agree, or a user can
    // create a workspace they are immediately refused admin of.
    const entitled = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users
        WHERE id = $1 AND deleted_at IS NULL
          AND ${activeEnterpriseSql('')}`,
      [ownerUserId],
    );
    if (!entitled) {throw new ForbiddenException('enterprise_subscription_required');}

    // A COMPANY AGENT (agency) is already an org — a workspace row on top
    // would be a second, redundant org identity (the F5 backfill excluded
    // them for exactly this reason), and since round 2 that row would also
    // rewrite the agency's role semantics and vocabulary (org_is_workspace,
    // demote targets). Mirror of the join lane's workspace_owner_cannot_join.
    const company = await this.db.qOne<{user_id: string}>(
      `SELECT user_id FROM agents WHERE user_id = $1 AND type = 'company'`,
      [ownerUserId],
    );
    if (company) {throw new ForbiddenException('provider_account_cannot_own_workspace');}

    const existing = await this.db.qOne<OrgWorkspace>(
      `SELECT owner_user_id, name, created_at::text
         FROM public.org_workspaces WHERE owner_user_id = $1`,
      [ownerUserId],
    );
    if (existing) {throw new ConflictException('workspace_already_exists');}

    const row = await this.db.qOne<OrgWorkspace>(
      `INSERT INTO public.org_workspaces (owner_user_id, name)
       VALUES ($1, $2)
       -- Two taps on Create race here exactly as two managers race on a roster
       -- month. Losing that race is not an error the user caused.
       ON CONFLICT (owner_user_id) DO NOTHING
       RETURNING owner_user_id, name, created_at::text`,
      [ownerUserId, trimmed],
    );
    if (!row) {throw new ConflictException('workspace_already_exists');}

    await this.audit.log(ownerUserId, ownerUserId, 'org.workspace.create', {
      targetKind: 'org_workspace', targetId: ownerUserId,
      metadata: {name: trimmed},
    });

    // ── SEED THE WORKSPACE ──────────────────────────────────────────────────
    //
    // Found on staging 2026-08-05, not by any test: a brand-new Enterprise
    // workspace came up EMPTY — no default channels and, worse, no
    // `#broadcast`. Frame A9 says #broadcast exists at every level, and the
    // owner's first sight of the product they just bought was a blank list.
    //
    // `seedOrgWorkspace` existed and did exactly this, but its only caller was
    // the SERVICE-PROVIDER funnel (`agent.service.ts`, where a company agent is
    // minted). Phase 6 added a SECOND way to become an org — this route — and
    // wired none of it. The same shape this scope keeps hitting: the rule lives
    // on the one creation path that existed when it was written, and is absent
    // on the new one. The question that would have caught it is "what ELSE
    // creates an org?", asked before writing the route rather than after.
    //
    // Note F5's backfill repaired orgs that already had channels, and
    // `createChannel` covers channels made from now on — a workspace with
    // neither fell between them.
    //
    // Best-effort on purpose: the workspace itself is committed and the user
    // owns it. A seeding failure must not turn a successful create into an
    // error, and it self-heals — seedOrgWorkspace is idempotent (it early-
    // returns once any channel exists) and ensureBroadcastForLevel re-runs on
    // the next channel creation.
    try {
      // 'workspace' tenant — generalized channel names, not the agency set.
      await this.department.seedOrgWorkspace(ownerUserId, 'workspace');
    } catch (e) {
      this.log.warn(`seedOrgWorkspace failed for new workspace ${ownerUserId}: ${(e as Error).message}`);
    }
    return row;
  }

  /** The caller's own workspace, or null. Drives the post-create routing. */
  async myWorkspace(ownerUserId: string): Promise<OrgWorkspace | null> {
    return this.db.qOne<OrgWorkspace>(
      `SELECT owner_user_id, name, created_at::text
         FROM public.org_workspaces WHERE owner_user_id = $1`,
      [ownerUserId],
    );
  }

  /**
   * THE org context for this caller — one resolver, used by the read AND the
   * write, in the same order `OrgManagerGuard` uses.
   *
   * It was two functions, and they disagreed. `getSettings` resolved "owner,
   * else oldest active membership of ANY role"; `setHiddenModules` resolved
   * "owner, else manager-role membership". A user who is an employee of A (the
   * older row) and a manager of B therefore LOADED A's toggles into the sheet
   * and SAVED them onto B — rewriting B's settings to A's without touching a
   * row, and the audit recorded it as intent.
   *
   * Arms, in the guard's order:
   *   1. an ACTIVE company agent — an agency IS its own org
   *   2. a workspace owner whose Enterprise is live — their own id is the org
   *   3. a delegated manager — the org they manage
   *   4. any other active member — the org they belong to, read-only
   *
   * Arm 1 was missing entirely, which made the whole feature dead for agencies
   * while its UI was still advertised to them: a company owner got 403 and its
   * delegated manager got a 500 from the settings FK. Arm 2's lapse check was
   * missing too, so a lapsed owner who manages another workspace edited the
   * lapsed one and saw their Save do nothing.
   */
  async resolveOrgContext(
    userId: string,
    /**
     * vs2 item 4 — WHICH org, when the caller belongs to several.
     *
     * Threaded in from the controller. Without it this resolver answered with
     * the caller's OLDEST membership regardless of what they were looking at —
     * so a manager of Meridian (Jan) and Delta (Jun) who opened the module
     * sheet inside Delta was shown MERIDIAN's toggles and, on Save, silently
     * rewrote Meridian. A wrong-org WRITE with a 200 and an audit row naming it
     * as intent.
     *
     * The unification that put the read and the write on one resolver made them
     * agree with each other; it did not make either agree with the org on
     * screen. Multi-org is what turned that from latent into live.
     */
    requested: string | null = null,
    opts?: {forWrite?: boolean},
  ): Promise<{orgUserId: string; canManage: boolean} | null> {
    const asCompany = await this.db.qOne<{user_id: string}>(
      `SELECT user_id FROM agents WHERE user_id = $1 AND type = 'company' AND status = 'ACTIVE'`,
      [userId],
    );
    // A named org that is NOT this one falls through to the membership arm —
    // the same precedence change the guard needed for Option A.
    /**
     * COLLECTED, not returned — mirroring OrgManagerGuard exactly.
     *
     * Round 1 made each arm return early ONLY when the header agreed, which
     * silently discarded it otherwise. On a stale or foreign header a company
     * agent or workspace owner fell through to the membership arm and got
     * `null` — and null is not "no opinion": it renders as
     * `{orgUserId: null, hiddenModules: []}`, which the client reads as "hide
     * nothing" with Save ENABLED. One tap then PATCHes an empty set. That is
     * the destructive Save this sheet's `loaded` flag exists to prevent,
     * reachable again through a different door.
     *
     * One candidate list, one `pickOrgContext`, the guard's precedence — so a
     * header matching nothing falls back to the caller's real primary org
     * instead of erasing them.
     */
    const candidates: Array<{org_user_id: string; member_role: string; department: string | null}> = [];
    if (asCompany) {
      candidates.push({org_user_id: asCompany.user_id, member_role: 'manager', department: null});
      if (!requested) {return {orgUserId: asCompany.user_id, canManage: true};}
    }

    // Lapse-aware, exactly as the guard is: on lapse the client hides the
    // workspace and the server refuses, so the two agree.
    const asOwner = await this.db.qOne<{owner_user_id: string}>(
      `SELECT w.owner_user_id
         FROM public.org_workspaces w
         JOIN public.users u ON u.id = w.owner_user_id
        WHERE w.owner_user_id = $1
          AND u.deleted_at IS NULL
          AND ${activeEnterpriseSql('u')}`,
      [userId],
    );
    if (asOwner) {
      candidates.push({org_user_id: asOwner.owner_user_id, member_role: 'manager', department: null});
      if (!requested) {return {orgUserId: asOwner.owner_user_id, canManage: true};}
    }

    // ALL of them, ordered — then the header narrows. `LIMIT 1` here was the
    // bug above; `created_at ASC` keeps the no-header default deterministic.
    const memberships = await this.db.q<{org_user_id: string; member_role: string; department: string | null}>(
      `SELECT org_user_id, member_role, department
         FROM public.org_members
        WHERE member_user_id = $1 AND status = 'active'
        ORDER BY created_at ASC`,
      [userId],
    );
    candidates.push(...memberships);
    // A WRITE naming an org that is not (or is no longer) the caller's must
    // refuse, not fall back — see pickOrgContextForWrite.
    if (opts?.forWrite) {
      const {row, refused} = pickOrgContextForWrite(candidates, requested);
      if (refused) {throw new ForbiddenException('org_context_unknown');}
      if (!row) {return null;}
      return {orgUserId: row.org_user_id, canManage: row.member_role === 'manager' && row.department === null};
    }
    const asMember = pickOrgContext(candidates, requested);
    if (!asMember) {return null;}
    // A DEPARTMENT-SCOPED manager may not make an ORG-WIDE change. Every
    // attendance and incident service applies that scope as a forced filter, so
    // letting a Sales-only manager blank Attendance for the whole company would
    // be the one place their scope stopped applying.
    const canManage = asMember.member_role === 'manager' && asMember.department === null;
    return {orgUserId: asMember.org_user_id, canManage};
  }

  /** The org this caller may ADMINISTER, or 403. */
  async assertManagerOrg(userId: string, requested: string | null = null): Promise<string> {
    const ctx = await this.resolveOrgContext(userId, requested, {forWrite: true});
    if (!ctx?.canManage) {throw new ForbiddenException('org_manager_access_required');}
    return ctx.orgUserId;
  }

  /**
   * The modules a workspace does not advertise.
   *
   * ECHOES `orgUserId` BACK. The client keys its state on the org the RESPONSE
   * names, never on the id it asked with — the request param is undefined on
   * most paths (drawer, CPO shell, notification taps), so a request-keyed store
   * collapses every workspace into one bucket exactly where cross-workspace
   * bleed matters most.
   *
   * FAILS OPEN by construction: no row → `[]` → everything visible, which is
   * what every org did before this feature existed.
   */
  async getSettings(
    orgUserId: string,
  ): Promise<{orgUserId: string; hiddenModules: string[]; levelNames: string[]}> {
    const row = await this.db.qOne<{hidden_modules: string[]; level_names: string[]}>(
      `SELECT hidden_modules, level_names FROM public.org_workspace_settings WHERE org_user_id = $1`,
      [orgUserId],
    );
    return {
      orgUserId,
      hiddenModules: row?.hidden_modules ?? [],
      // PDF checklist line 9. Same fail-open shape as hiddenModules: no row, or
      // a row that never chose names, yields [] - which the client reads as
      // "use the built-in vocabulary", i.e. exactly today's behaviour.
      levelNames: row?.level_names ?? [],
    };
  }

  /**
   * Replace this org's hierarchy tier NAMES. Manager-only (controller guard).
   *
   * PDF checklist line 9 - "Admins can choose the names of levels."
   * PRESENTATION ONLY: this table's own header states that nothing in it is
   * read by an authorisation check, and a tier NAME decides nothing. Depth is
   * still governed by department_channels.level and its CHECK, so renaming a
   * tier cannot move a channel, change who sees it, or add a fifth level.
   *
   * A WHOLE-ARRAY REPLACE, for the reason setHiddenModules documents: two
   * admins editing from stale screens would otherwise interleave into a set
   * neither chose.
   *
   * Normalised HERE as well as on the client, because the client is not a
   * boundary - an older app or a direct API call reaches this too. Trailing
   * blanks are dropped so "renamed L1 only" stores ['Region'] and not
   * ['Region','','',''], and an all-blank array stores [] which means "back to
   * the built-ins" - that is what makes the editor's clear-to-reset work
   * without a separate action.
   */
  async setLevelNames(
    orgUserId: string,
    actorId: string,
    requested: readonly string[],
  ): Promise<{orgUserId: string; hiddenModules: string[]; levelNames: string[]}> {
    const MAX_TIERS = 4;
    const MAX_LEN = 24;
    const names = requested
      .slice(0, MAX_TIERS)
      .map(v => (typeof v === 'string' ? v : '').trim().slice(0, MAX_LEN));
    while (names.length > 0 && names[names.length - 1] === '') {names.pop();}

    const before = (await this.getSettings(orgUserId)).levelNames;

    await this.db.qOne(
      `INSERT INTO public.org_workspace_settings (org_user_id, level_names, updated_by)
            VALUES ($1, $2::text[], $3)
       ON CONFLICT (org_user_id) DO UPDATE
              SET level_names = EXCLUDED.level_names,
                  updated_by  = EXCLUDED.updated_by,
                  updated_at  = now()`,
      [orgUserId, names, actorId],
    );

    await this.audit.log(orgUserId, actorId, 'workspace.settings.update', {
      targetKind: 'org_workspace_settings',
      targetId: orgUserId,
      metadata: {field: 'level_names', before, after: names},
    });

    return {...(await this.getSettings(orgUserId)), levelNames: names};
  }

  /**
   * Replace the hidden-module set. Manager-only (the controller's guard).
   *
   * A WHOLE-SET REPLACE, not add/remove: two admins toggling different cards
   * from stale screens would otherwise interleave into a set neither chose.
   * Replacing makes the last writer's intent the state, which is at least a
   * state somebody actually asked for.
   *
   * The valid set is enforced HERE rather than by a CHECK constraint — see the
   * migration for why — and an unknown value is dropped rather than 400ing, so
   * an older app that has not learned a new module name cannot be locked out of
   * changing the ones it does know.
   */
  async setHiddenModules(
    orgUserId: string,
    actorId: string,
    requested: readonly string[],
  ): Promise<{orgUserId: string; hiddenModules: string[]; levelNames: string[]}> {
    const VALID = new Set(['attendance', 'incidents']);
    // De-duplicated and ordered so the stored value, the audit diff and the
    // response are all comparable by equality rather than by set-membership.
    const hidden = [...new Set(requested.filter(m => VALID.has(m)))].sort();

    const before = (await this.getSettings(orgUserId)).hiddenModules;

    await this.db.qOne(
      `INSERT INTO public.org_workspace_settings (org_user_id, hidden_modules, updated_by)
            VALUES ($1, $2::text[], $3)
       ON CONFLICT (org_user_id) DO UPDATE
              SET hidden_modules = EXCLUDED.hidden_modules,
                  updated_by     = EXCLUDED.updated_by,
                  updated_at     = now()`,
      [orgUserId, hidden, actorId],
    );

    // BEFORE and AFTER, explicitly. "settings changed" is unanswerable three
    // months later; the 2026-08-04 review made stating both the house rule.
    await this.audit.log(orgUserId, actorId, 'workspace.settings.update', {
      targetKind: 'org_workspace_settings',
      targetId: orgUserId,
      metadata: {before, after: hidden},
    });

    // Re-read rather than echoing, so the caller always gets BOTH fields and a
    // partial write can never look like a full one.
    return {...(await this.getSettings(orgUserId)), hiddenModules: hidden};
  }
}
