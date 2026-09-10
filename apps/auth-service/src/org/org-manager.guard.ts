import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {activeEnterpriseSql} from '../common/guards/tier.guard';
import type {AccessClaims} from '../auth/jwt.service';
import {readOrgContextHeader, pickOrgContext} from './org-context';

/**
 * OrgManagerGuard — authorizes a caller as a MANAGER of a service-provider org.
 *
 * A service provider is the `company` agent's users.id (the single tenant key,
 * the same id department_channels.org_id references). A manager is either:
 *   - that org user itself (the company account), or
 *   - the OWNER of an Enterprise workspace (their own single-tenant org), or
 *   - an org_members row with member_role='manager', status='active'.
 *
 * ⛔ BUYING A SUBSCRIPTION IS NOT ONE OF THEM (F2).
 *
 * There used to be a fourth arm here: any ACTIVE enterprise-tier user was
 * admitted as manager of an implicit org whose id was their own user id. That
 * made the PAYMENT the authorization — frame A4 says "Admin selection alone must
 * never create authority" and "a user without a verified path must not reach
 * Admin controls", and a tier is not a verified path. Measured before removal: a
 * plain enterprise-tier individual with no workspace and no org reached
 * `POST /department/channels` with a 200.
 *
 * The tier still GATES the paid surface — `WorkspaceService.createWorkspace`
 * requires active Enterprise, and `DeptChatAccessGuard` still admits an
 * enterprise individual to the department MODULE. What it no longer does is
 * grant admin authority: the buyer becomes an admin by CREATING the workspace
 * (Path 1b), which is the verified path. Do NOT re-add a tier arm here without
 * re-adding it to `resolveIsOrgManager` too — see the mirror note there.
 *
 * Modeled on AdminGuard (ops/admin.guard.ts): it RE-READS the DB rather than
 * trusting any claim baked into the JWT, so a stale token can't fabricate org
 * ownership. The JWT shape is intentionally NOT changed (auth-token security
 * stop-condition) — org identity is always derived here from org_members.
 *
 * Apply AFTER JwtAuthGuard so `req.user` is populated. Attaches the resolved
 * manager context to `req.orgManager`.
 *
 * NOTE: this is a DIFFERENT trust tier from admin_users (HQ ops staff). A
 * provider manager must never reach ops-only routes, so do not conflate the two.
 */
export interface OrgManagerContext {
  // The user id of the calling manager.
  user_id: string;
  // The org (service provider) this manager governs. For the company account
  // itself this equals user_id; for a delegated manager it's their org.
  org_user_id: string;
  // Department scope (PDF p.9/p.16): NULL = whole org (company account or an
  // unscoped manager); set = a delegated manager who only sees that
  // department's attendance + incidents. Services apply it as a forced filter.
  department: string | null;
}

/**
 * Attach the resolved context and admit. One writer, so the three arms cannot
 * drift in what they stamp.
 */
function stamp(
  req: {orgManager?: OrgManagerContext},
  userId: string,
  row: {org_user_id: string; department: string | null},
): true {
  req.orgManager = {user_id: userId, org_user_id: row.org_user_id, department: row.department ?? null};
  return true;
}

@Injectable()
export class OrgManagerGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      user?: AccessClaims;
      orgManager?: OrgManagerContext;
      headers?: Record<string, unknown>;
    }>();

    const claims = req.user;
    if (!claims) throw new ForbiddenException('Not authenticated');

    /**
     * vs2 item 4 — MULTI-ORG. Authority follows the organisation being viewed.
     *
     * Founder decision 2026-08-12 (Option A): a manager who belongs to several
     * organisations administers whichever one they are currently looking at, and
     * there is no cap on how many they may hold. Slack/Notion/Workspace all
     * behave this way, and the alternative — "you are a manager here in real
     * life but not in the app" — reads as a bug with nowhere to explain it.
     *
     * ⚠️ THE HEADER IS A REQUEST, NEVER A GRANT. It names WHICH of the caller's
     * memberships to use; it can never create one. Every arm below re-queries
     * the caller's real rows and the header only ever NARROWS that set. A
     * client asking for an org it does not belong to is refused, not obeyed —
     * otherwise this header would be a one-line cross-tenant escalation.
     *
     * Absent header = today's behaviour exactly (first matching arm wins), so
     * every existing caller and every older build is unaffected.
     */
    const requested = readOrgContextHeader(req);

    // Path 1: the caller is itself an ACTIVE `company` agent — it is its own org.
    // D4-c — a suspended/deactivated company (status <> 'ACTIVE') must lose manager access.
    const asOrg = await this.db.qOne<{user_id: string}>(
      `SELECT user_id FROM agents WHERE user_id = $1 AND type = 'company' AND status = 'ACTIVE'`,
      [claims.sub],
    );
    // COLLECTED, not returned. Before item 4 each arm returned the moment it
    // matched, because a person could hold at most one of them. Now a single
    // person can be a company agent, a workspace owner AND a manager elsewhere,
    // so all three are gathered and the header chooses among them. With no
    // header the FIRST still wins, which is the pre-item-4 precedence exactly.
    const candidates: Array<{org_user_id: string; department: string | null}> = [];
    if (asOrg) {
      candidates.push({org_user_id: claims.sub, department: null});
      // NO HEADER ⇒ SHORT-CIRCUIT, exactly as before item 4.
      //
      // Gathering all three arms unconditionally would cost every company
      // agent two extra queries on every manager route, to choose between
      // candidates it was never going to be asked about. The extra reads are
      // only justified when the client has actually named an organisation,
      // which is the multi-org case. Rule 7's one-read path is preserved.
      if (!requested) {return stamp(req, claims.sub, candidates[0]);}
    }

    // Path 1b: the caller OWNS an Enterprise workspace (Scope v2 Phase 6).
    //
    // THIS IS THE ONLY PATH AN ENTERPRISE BUYER HAS, since the tier-only arm
    // was removed (F2). It carries two jobs:
    //
    //   1. ADMISSION. An owner has no agents row (deliberately: owners are not
    //      minted through the service-provider funnel) and no org_members row
    //      (ownership lives in its own table), so without this arm the person
    //      who just created the workspace 403s on every manager route — the
    //      roster surface, channel management, and the join-approval inbox.
    //      An Enterprise workspace nobody can administer is not a workspace.
    //      (An earlier comment claimed the old Path 3 already covered this. It
    //      did — and that WAS the defect: the coverage came from the tier, so
    //      buyers who never created a workspace were admitted too.)
    //
    //   2. ORDERING. It runs BEFORE Path 2 (delegated manager), so an owner of
    //      workspace A who is ALSO a delegated manager of org B resolves to
    //      their OWN org A rather than to B. Without it Path 2 wins and the
    //      founder of A administers B when they open their own workspace.
    //
    // Lapse-aware, matching the client's owns_workspace: on lapse the client
    // hides the workspace and the server refuses, so the two agree.
    const asOwner = await this.db.qOne<{owner_user_id: string}>(
      `SELECT w.owner_user_id
         FROM public.org_workspaces w
         JOIN public.users u ON u.id = w.owner_user_id
        WHERE w.owner_user_id = $1
          AND u.deleted_at IS NULL
          AND ${activeEnterpriseSql('u')}`,
      [claims.sub],
    );
    if (asOwner) {
      candidates.push({org_user_id: asOwner.owner_user_id, department: null});
      // `candidates[0]` would be equivalent — reaching here with no header
      // means Path 1 did not match — but naming the row just pushed says what
      // is meant without depending on that reasoning staying true.
      if (!requested) {return stamp(req, claims.sub, candidates[candidates.length - 1]);}
    }

    /**
     * Path 2: the caller is a delegated manager of some org — possibly SEVERAL.
     *
     * `q`, not `qOne`. Before item 4 a person could have at most one active
     * membership, so "the org they manage" was a single row and `qOne` was
     * honest. Now it is a set, and taking whichever row Postgres returned first
     * would mean a manager of two companies administering an arbitrary one of
     * them — and, worse, a DIFFERENT arbitrary one between requests, because
     * without ORDER BY that order is not stable.
     *
     * `created_at ASC` makes the no-header default deterministic (the oldest
     * membership — the same "first" every time), and the header then picks
     * among them.
     */
    const managedOrgs = await this.db.q<{org_user_id: string; department: string | null}>(
      `SELECT org_user_id, department
         FROM org_members
        WHERE member_user_id = $1
          AND member_role = 'manager'
          AND status = 'active'
        ORDER BY created_at ASC`,
      [claims.sub],
    );
    candidates.push(...managedOrgs);

    // ONE choice, across every org this caller may administer. The header can
    // only ever select from this list — it cannot add to it.
    const chosen = pickOrgContext(candidates, requested);
    if (chosen) {
      /**
       * NO "the header is mandatory for writes" RULE HERE. I added one and it
       * was wrong; this comment is so nobody adds it back.
       *
       * The idea was sound in isolation — a write that could land on either of
       * two orgs should say which, because it 200s and files an audit row
       * naming an org the user never chose. What makes it unshippable is that
       * the CLIENT cannot always send one:
       *
       *   - The context is set in exactly two places (the Workspace Hub tile
       *     and invite-accept) and is deliberately NOT persisted, so it is null
       *     after every cold start. The drawer, the CPO shells, the agent
       *     dashboard and every notification deep-link enter the same surface
       *     with no context at all.
       *   - This guard is mounted class-wide on THREE dispatch controllers.
       *     A delegated manager of an agency who is also a manager of a client
       *     workspace — precisely the persona item 4 enables — would have been
       *     403'd on Accept Offer and Claim Job. That is the agency's revenue
       *     lane, killed by a rule meant to protect a settings screen.
       *
       * A server rule can only require what every door already sends. The
       * wrong-org write is defended on the client instead, at the one screen
       * that can actually see which organisation it is drawing
       * (ModuleVisibilitySheet compares the org the response echoes against the
       * org on screen and refuses to save on a mismatch).
       */
      return stamp(req, claims.sub, chosen);
    }

    // NO TIER ARM. There is deliberately no fourth path reading
    // users.subscription_tier here: buying Enterprise is a PAYMENT, not a
    // verified path to authority (frame A4). The buyer reaches admin by
    // creating a workspace, which Path 1b then admits.
    throw new ForbiddenException('org_manager_access_required');
  }
}

/**
 * Tenant-isolation guard rail. Throws if a manager tries to act on an org that
 * is not their own. Mirrors assertRegionScope (ops/admin.guard.ts) — call at the
 * service layer right after resolving the target org from a request param.
 */
export function assertOrgScope(manager: OrgManagerContext, targetOrgId: string): void {
  if (manager.org_user_id !== targetOrgId) {
    throw new ForbiddenException(
      `org_scope_violation:${manager.org_user_id}!=${targetOrgId}`,
    );
  }
}
