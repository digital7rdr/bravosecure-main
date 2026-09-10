import {BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {randomInt} from 'node:crypto';
import {DatabaseService, type Tx} from '../database/database.service';
import type {QueryResultRow} from 'pg';
import {OrgAuditService} from '../org/org-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {DepartmentService} from './department.service';
import type {ChannelAccess, ChannelType, ChannelPostMode} from './dto/channel.dto';
import {resolveSeedScope, type SeedCandidate, type SeedScope} from './seed-path';

/**
 * Enterprise Dept Channels scope v2 — Phase 3: the join → approve loop.
 *
 * Frames M5 (Join Workspace / Referral Request), M11A (Approval Result) and
 * A11 (Approvals / Notifications).
 *
 * ── WHY THIS IS ITS OWN SERVICE, WITH ITS OWN TABLE ─────────────────────────
 *
 * M11A: "Pending means no Enterprise content or metadata is visible."
 * A11:  "Pending applicants receive no Department Channels, Attendance,
 *        Incident or Vault access."
 *
 * A pending request creates NO `org_members` row. Not because every reader
 * filters on `status = 'active'` — twelve of them do not, correctly, since an
 * admin roster must show suspended and removed members — but because **there is
 * no row at all**, so every read returns nothing whether it filters or not, in
 * today's modules and in ones added later. Approval is what creates the row.
 *
 * The module guard does not carry this either: `DeptChatAccessGuard` Path 3
 * admits an ACTIVE Enterprise-tier individual with no membership row (their org
 * is their own user id), and a pending joiner is very often exactly that person
 * — they had to pick a plan to reach M5. What protects the TARGET org is
 * org-id resolution: with no membership row their org resolves to themselves,
 * so they see their own empty workspace, never the Enterprise they applied to.
 */
@Injectable()
export class EnterpriseJoinService {
  private readonly log = new Logger(EnterpriseJoinService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OrgAuditService,
    // The FCM wake + durable inbox row, in one call (R13-2 closed — see the
    // NOTIFICATION STRATEGY note below).
    private readonly push: BookingPushBridge,
    // Injected so the channel seed goes through addMember (the only path that
    // enqueues the rekey intent) instead of a raw INSERT.
    private readonly department: DepartmentService,
  ) {}

  // NOTIFICATION STRATEGY (A11 + page 10 rule 3, R13-2 closed 2026-08-07).
  // All join-loop notifies ride `BookingPushBridge`, which publishes the FCM
  // wake AND writes the durable inbox row in one call (N-20) — do NOT add a
  // separate `notifications.record` call in this service; that double-writes
  // the Activity Centre row (a spec scans for it). Fire-and-forget by
  // contract: `publish` swallows its own errors, so a notification failure
  // can never roll back a decision that already committed. The loop remains
  // completable with no wake at all — M11A is state-driven (myJoinRequest)
  // and both screens refetch on focus, so a dead token degrades to inbox
  // backfill latency, never correctness.

  /**
   * The people who can actually action a join request: the org account plus its
   * active delegated managers, BRANCH-FILTERED exactly as
   * IncidentService.resolveOrgManagers does.
   *
   * The `department` predicate is not optional dressing. Without it the fan-out
   * and `listPendingRequests` disagree the moment teams become real: a scoped
   * manager gets pinged about a request their own inbox filter hides.
   */
  private async resolveOrgManagers(orgUserId: string, department?: string | null): Promise<string[]> {
    const mgrs = await this.db.q<{member_user_id: string}>(
      `SELECT member_user_id FROM org_members
        WHERE org_user_id = $1 AND member_role = 'manager' AND status = 'active'
          AND ($2::text IS NULL OR department IS NULL OR department = $2)`,
      [orgUserId, department ?? null],
    );
    return [orgUserId, ...mgrs.map(m => m.member_user_id)];
  }

  /** Fan-out for a new request: every manager who could action it — and ONLY
   *  them. The referrer used to be pushed unconditionally, but a member (or
   *  demoted) referrer's tap lands on the manager-only Approvals inbox and
   *  403s into an error state, so "notified" must equal "can action"; a
   *  referrer who is a manager is already in the set (edge-case review,
   *  2026-08-07). Branch-scoped to the requested team so the people notified
   *  are the same people whose inbox will show it.
   *
   *  Parallel on purpose: each publish is three sequential I/Os and this loop
   *  runs inline in the submit request. `publish` never rejects, so
   *  `allSettled` is belt-and-braces, not error handling. */
  private async notifyJoinAdmins(orgUserId: string, department?: string | null): Promise<void> {
    const admins = await this.resolveOrgManagers(orgUserId, department);
    await Promise.allSettled(
      // vs2 edge A2 — the org rides along so a two-org admin's tap opens THIS
      // workspace's inbox, not whichever one their session was sticky on.
      [...new Set(admins)].map(uid => this.push.enterpriseJoinRequested(uid, orgUserId)),
    );
  }

  /**
   * Shared mint-time team validation (referral links AND member invites — one
   * copy, per the duplicate-copy rule).
   *
   * Tenancy: the team must belong to THIS Enterprise, or a link could point
   * applicants at another org's branch (page 10 rule 2). And a managers-only
   * channel can never be a JOIN TARGET: validating only the org let a link
   * point at a restricted or incident channel, and an "always seed the
   * referred team" rule would then force an ordinary employee into it.
   * Refusing at MINT is the honest place: the admin finds out when they create
   * the link, not silently at approval time.
   *
   * The branch rule now lives INSIDE this call (vs2 item 2 — one shared
   * predicate with the picker's greying), so the returned department is
   * vestigial: neither caller reads it. Kept only to avoid a signature churn in
   * the same commit as a permission change.
   */
  private async assertMintableTeam(
    // REQUIRED, with no default. A default of null is a fail-open: the referral
    // -link caller omitted it for exactly that reason and a branch-scoped
    // manager could mint an open, multi-use link bound to a team outside their
    // branch — the one thing the direct-invite path 403s. Requiring the
    // argument turns "which scope applies here?" into a decision each caller
    // has to make out loud.
    orgUserId: string, teamChannelId: string, managerDepartment: string | null,
  ): Promise<{department: string | null; parentId: string | null}> {
    const ch = await this.db.qOne<{
      org_id: string; access: ChannelAccess; channel_type: ChannelType;
      department: string | null; archived: boolean; is_broadcast: boolean;
      // Item 04/D-5 — the shared predicate now also refuses an ANNOUNCEMENT
      // channel, which on a workspace is a lateral with post_mode 'announcement'
      // rather than an is_broadcast row. Selected here so this caller asks the
      // same question the picker's greying asks.
      post_mode: ChannelPostMode;
      parent_id: string | null;
    }>(
      // archived is selected as FALSE rather than dropping the WHERE clause:
      // the filter is what makes an archived team read as "not found" here, and
      // the shared predicate wants the field present either way.
      `SELECT org_id, access, channel_type, department, is_broadcast, post_mode, parent_id,
              FALSE AS archived
         FROM public.department_channels
        WHERE id = $1 AND archived_at IS NULL`,
      [teamChannelId],
    );
    // vs2 item 2 — ONE predicate, shared with the `mintable_by_me` the picker
    // greys by, so the greying and the refusal can never disagree. The branch
    // arm is a 403 while the rest are 400s, which is the split this call already
    // had when the branch check lived at the call site.
    const refusal = DepartmentService.mintRefusalFor(
      ch, orgUserId, managerDepartment,
      await this.department.isWorkspaceTenant(orgUserId),
    );
    if (refusal === 'team_channel_outside_your_branch') {throw new ForbiddenException(refusal);}
    if (refusal) {throw new BadRequestException(refusal);}
    return {department: ch?.department ?? null, parentId: ch?.parent_id ?? null};
  }

  /** A11 — an admin mints a shareable referral link for a specific team. */
  async createReferralLink(
    orgUserId: string, managerUserId: string,
    input: {team_channel_id?: string; expires_in_days?: number},
  ): Promise<{code: string; expires_at: string | null}> {
    let teamParentId: string | null = null;
    if (input.team_channel_id) {
      // Why null: the referral lane performs NO branch check today and this
      // batch deliberately does not add one — that is a scope decision for the
      // founder (plan §10.11), not a side effect of sharing a predicate. Passed
      // explicitly rather than defaulted so the exemption is visible here
      // instead of hiding in a signature. Pinned by mintableTeamSingleSource.
      teamParentId = (await this.assertMintableTeam(orgUserId, input.team_channel_id, null)).parentId;
    }
    const code = this.mintCode();
    const days = Math.min(Math.max(input.expires_in_days ?? 7, 1), 90);
    const row = await this.db.qOne<{id: string; code: string; expires_at: Date | null}>(
      `INSERT INTO public.enterprise_referral_links
         (code, org_user_id, referrer_user_id, team_channel_id, team_parent_id,
          expires_at, created_by)
       VALUES ($1, $2, $3, $4, $6, NOW() + ($5 || ' days')::interval, $3)
       RETURNING id, code, expires_at`,
      [code, orgUserId, managerUserId, input.team_channel_id ?? null, String(days), teamParentId],
    );
    if (!row) throw new BadRequestException('referral_link_create_failed');
    // targetId MUST be the row's UUID, never the code.
    //
    // `org_audit_log.target_id` is a UUID column, and a referral code is an
    // 8-char string like 'YLDZ3KGV' — Postgres rejects it with
    // `invalid input syntax for type uuid`, which surfaced as a 500 from this
    // whole endpoint. Minting a link was therefore impossible, which blocks the
    // entire join -> approve loop.
    //
    // No unit test could see it: every spec mocks OrgAuditService, so the audit
    // INSERT never runs. Found only by calling the real endpoint against the
    // real database. The code still travels in `metadata`, where the column is
    // jsonb and a string is valid.
    await this.audit.log(orgUserId, managerUserId, 'enterprise.referral_link.create', {
      targetKind: 'referral_link', targetId: row.id,
      metadata: {code, team_channel_id: input.team_channel_id ?? null, expires_in_days: days},
    });
    return {code: row.code, expires_at: row.expires_at ? row.expires_at.toISOString() : null};
  }

  /**
   * M5 — resolve a link so the applicant sees which Enterprise/team they are
   * applying to BEFORE submitting.
   *
   * "Expired or revoked links show a safe message without exposing organisation
   * data" — so an invalid code returns a bare `{valid: false}`. It must not leak
   * the org name, the team name, or even whether that code ever existed.
   *
   * B-413/Phase B — when the CALLER's accept could only 409 (active membership
   * in a different org — the one-active-org rule), an otherwise-valid INVITE
   * link resolves `{valid: false, reason: 'already_active_in_another_org'}`
   * instead of arming a Join button. The reason is the caller's OWN state —
   * never organisation data. Workspace OWNERS resolve normally since Phase B
   * (founder-approved 2026-08-09). `callerUserId` is optional so code paths
   * without an identity keep today's behaviour.
   */
  async resolveReferralLink(code: string, callerUserId?: string): Promise<
    {valid: false; reason?: 'already_active_in_another_org'} |
    {valid: true; org_name: string | null; team_name: string | null; code: string;
     invite?: {invited_role: 'employee' | 'manager'}}
  > {
    const row = await this.db.qOne<{
      org_name: string | null; team_name: string | null;
      team_access: ChannelAccess | null; team_type: ChannelType | null;
      is_invite: boolean; invited_role: 'employee' | 'manager';
      org_user_id: string;
    }>(
      // ARCHIVED TEAM: degrade the NAME, never the SAFETY CHECK.
      //
      // An archived team must read as "no specific team" rather than
      // invalidating the whole link — the seed excludes archived channels, so
      // otherwise M5 promises a placement that will never happen. But putting
      // that filter on the JOIN also nulled team_access/team_type, which
      // silently DISARMED the managers-only refusal below: archive a restricted
      // channel and its links became submittable again. So the join resolves
      // unconditionally and only the display fields are gated on archived_at.
      // THE COMPANY'S NAME, NOT THE FOUNDER'S. `u.display_name` is the owner
      // USER — a person — so an applicant was shown the founder's personal name
      // as the organisation they were joining. Wrong, and a privacy leak to
      // someone who is not yet a member. The workspace name is the org's own
      // identity; fall back to the user only for pre-workspace orgs.
      // Item E: an invite row resolves with `invite` set so the client shows
      // "Join {org}" instead of "Submit request" — acceptance is a different
      // verb from application. An ACCEPTED invite stops resolving entirely
      // (accepted_at IS NULL below); legacy multi-use rows never set
      // accepted_at, so they are unaffected.
      `SELECT COALESCE(w.name, u.display_name) AS org_name,
              CASE WHEN c.archived_at IS NULL THEN c.name END AS team_name,
              c.access AS team_access, c.channel_type AS team_type,
              (l.invited_phone IS NOT NULL OR l.invited_email IS NOT NULL) AS is_invite,
              l.invited_role, l.org_user_id
         FROM public.enterprise_referral_links l
         JOIN public.users u ON u.id = l.org_user_id
    LEFT JOIN public.org_workspaces w ON w.owner_user_id = l.org_user_id
    LEFT JOIN public.department_channels c ON c.id = l.team_channel_id
        WHERE l.code = $1
          AND l.revoked_at IS NULL
          AND l.accepted_at IS NULL
          AND (l.expires_at IS NULL OR l.expires_at > NOW())`,
      [code.toUpperCase()],
    );
    if (!row) return {valid: false};
    // FAIL CLOSED on a managers-only target. The mint-time refusal only covers
    // links created after it shipped — an older link, or a row inserted
    // directly, still points at a restricted or incident channel, and this
    // endpoint would hand its NAME to any code holder ("hidden metadata is
    // filtered by the server", page 10 rule 2). It would also promise a team
    // the seed then silently skips.
    if (row.team_access && row.team_type
        && DepartmentService.seedsManagersOnly(row.team_access, row.team_type)) {
      return {valid: false};
    }
    if (callerUserId) {
      // Phase B (founder-approved 2026-08-09) — the workspace-owner refusal is
      // gone; owners resolve and accept like anyone else.
      // INVITE rows only: their accept dies on the one-active-org unique
      // index for a caller active in a DIFFERENT org. Referral (non-invite)
      // rows feed the join-REQUEST lane, where cross-org PENDING is
      // legitimate ("a member of org A can sit pending against org B") —
      // never block those here.
      /**
       * vs2 item 4 — NO CROSS-ORG REFUSAL LEFT HERE, deliberately.
       *
       * This blocked any caller already active in another org, then round 1
       * narrowed it to cpo rows. Both were wrong, because they mirrored a
       * refusal the ACCEPT no longer performs: grantMembership writes only
       * 'employee' | 'manager', and org_members_one_active_cpo is partial on
       * member_role = 'cpo', so a serving officer accepting a workspace invite
       * cannot violate it. That combination is the consultant case the
       * migration names as the reason this item exists.
       *
       * A hard {valid:false} here was the worst version of the mistake: the
       * code-entry lane refused outright, not merely greyed, for a person the
       * accept would have admitted.
       */
    }
    return {
      valid: true, code: code.toUpperCase(), org_name: row.org_name, team_name: row.team_name,
      // Role only — NOT invited_name: a referral code exposes no person's
      // name, and a phone-bound invite's holder may not even be the invitee.
      ...(row.is_invite ? {invite: {invited_role: row.invited_role}} : {}),
    };
  }

  /**
   * M5 — submit a request. Creates a PENDING record and nothing else.
   *
   * "The applicant cannot change the requested department or team": the team is
   * read from the LINK, never from the request body. There is deliberately no
   * team field on the DTO.
   */
  async submitJoinRequest(
    applicantUserId: string,
    input: {code: string; full_name?: string; phone?: string; email?: string; message?: string},
  ): Promise<{status: 'pending'; id: string}> {
    const link = await this.db.qOne<{
      id: string; org_user_id: string; referrer_user_id: string | null; team_channel_id: string | null;
      team_access: ChannelAccess | null; team_type: ChannelType | null; team_department: string | null;
    }>(
      // Same split as resolveReferralLink: access/channel_type resolve
      // unconditionally so the fail-closed refusal below cannot be disarmed by
      // archiving the channel; the DEPARTMENT degrades, so an archived team
      // routes the request to every manager rather than to a branch nobody
      // matches (see listPendingRequests, which uses the identical rule).
      // Invite rows are excluded here (Item E): a bound single-use invite is
      // ACCEPTED, never applied through. Letting it double as a referral code
      // would let a phone-bound invite's binding be sidestepped by submitting a
      // pending request with the same code. The client never routes here for an
      // invite (resolve returns `invite`), so this is the fail-closed backstop
      // and reuses the same safe message.
      `SELECT l.id, l.org_user_id, l.referrer_user_id, l.team_channel_id,
              c.access AS team_access, c.channel_type AS team_type,
              CASE WHEN c.archived_at IS NULL THEN c.department END AS team_department
         FROM public.enterprise_referral_links l
    LEFT JOIN public.department_channels c ON c.id = l.team_channel_id
        WHERE l.code = $1 AND l.revoked_at IS NULL
          AND l.invited_phone IS NULL AND l.invited_email IS NULL
          AND (l.expires_at IS NULL OR l.expires_at > NOW())`,
      [input.code.toUpperCase()],
    );
    // Same safe message as resolve — a revoked link must not become an oracle.
    if (!link) throw new BadRequestException('referral_link_invalid_or_expired');
    // FAIL CLOSED HERE TOO. Refusing only on the READ path left the write path
    // open: an older link could still be submitted, the request stored the
    // restricted team_channel_id, and listPendingRequests then surfaced that
    // channel's NAME in the admin inbox — the exact metadata the read-path
    // refusal exists to withhold. The UI blocking it is not the boundary
    // ("filtered by the server, not merely hidden by the client").
    if (link.team_access && link.team_type
        && DepartmentService.seedsManagersOnly(link.team_access, link.team_type)) {
      throw new BadRequestException('referral_link_invalid_or_expired');
    }

    // Already a member? Then there is nothing to request, and saying so does not
    // leak anything they cannot already see.
    const existing = await this.db.qOne<{status: string}>(
      `SELECT status FROM public.org_members
        WHERE org_user_id = $1 AND member_user_id = $2`,
      [link.org_user_id, applicantUserId],
    );
    if (existing && existing.status === 'active') throw new ConflictException('already_a_member');

    try {
      const row = await this.db.qOne<{id: string}>(
        `INSERT INTO public.enterprise_join_requests
           (org_user_id, applicant_user_id, link_id, applicant_name, applicant_phone,
            applicant_email, referrer_user_id, team_channel_id, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [link.org_user_id, applicantUserId, link.id, input.full_name ?? null, input.phone ?? null,
         input.email ?? null, link.referrer_user_id, link.team_channel_id, input.message ?? null],
      );
      if (!row) throw new BadRequestException('join_request_create_failed');
      // M5 — "Submit Request creates a pending record and NOTIFIES THE
      // AUTHORISED ADMIN." Notifying only the org account missed every
      // DELEGATED manager — precisely the population the branch filter on the
      // inbox exists for, i.e. the people who actually action these. Same
      // fan-out shape as IncidentService.resolveOrgManagers.
      // BEST-EFFORT, symmetrically with decideJoinRequest. These run AFTER the
      // request row is durable, so a blip here must not return 500 for a request
      // that exists. Applying the rule on one side only left the next reader to
      // guess which half was intentional.
      // BRANCH-SCOPED to the requested team, so the people notified are exactly
      // the people whose inbox will show it. Fanning out org-wide while
      // listPendingRequests filters by branch would ping a scoped manager about
      // a request they cannot see — an inconsistency that only becomes reachable
      // once teams are real, which is what the picker below makes true.
      await this.notifyJoinAdmins(link.org_user_id, link.team_department)
        .catch(e => this.log.warn(`join-request notify failed: ${(e as Error)?.message}`));
      return {status: 'pending', id: row.id};
    } catch (e: unknown) {
      // Page 10 rule 3 — "Duplicate submissions are prevented with operation
      // IDs/idempotency". The partial unique index is the guarantee; a
      // double-tap on Submit resolves to the SAME pending request rather than
      // erroring, because from the applicant's side the outcome is identical.
      if ((e as {code?: string})?.code === '23505') {
        const open = await this.db.qOne<{id: string}>(
          `SELECT id FROM public.enterprise_join_requests
            WHERE org_user_id = $1 AND applicant_user_id = $2 AND status = 'pending'`,
          [link.org_user_id, applicantUserId],
        );
        if (open) return {status: 'pending', id: open.id};
      }
      throw e;
    }
  }

  /**
   * Page 10 rule 2 — "revocable invitation tokens". Without this, revocation
   * was reachable only via psql: `revoked_at` existed and both queries filtered
   * on it, but nothing could ever set it.
   */
  async revokeReferralLink(orgUserId: string, managerUserId: string, code: string): Promise<{ok: true}> {
    // TENANCY in the WHERE clause, not a pre-read: an admin can only revoke a
    // link belonging to their own Enterprise.
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.enterprise_referral_links
          SET revoked_at = NOW()
        WHERE code = $1 AND org_user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [code.toUpperCase(), orgUserId],
    );
    if (!row) throw new NotFoundException('referral_link_not_found');
    // Same defect as create — the UPDATE already RETURNs id, so use it.
    await this.audit.log(orgUserId, managerUserId, 'enterprise.referral_link.revoke', {
      targetKind: 'referral_link', targetId: row.id,
      metadata: {code: code.toUpperCase()},
    });
    return {ok: true};
  }

  /** The admin's own links, so revoking one is possible from the UI. */
  async listReferralLinks(orgUserId: string): Promise<Array<{
    code: string; team_name: string | null; expires_at: string | null; revoked: boolean; created_at: string;
  }>> {
    return this.db.q(
      // ONE archived-team rule across the file: gate the NAME with a CASE, never
      // the join. A filtered join also nulls whatever else is selected from `c`,
      // which is how the managers-only refusal got disarmed on the write path.
      // Invite rows have their own list (listMemberInvites) — showing them here
      // too would double-render every invite on the Approvals screen.
      `SELECT l.code, CASE WHEN c.archived_at IS NULL THEN c.name END AS team_name, l.expires_at,
              (l.revoked_at IS NOT NULL) AS revoked, l.created_at
         FROM public.enterprise_referral_links l
    LEFT JOIN public.department_channels c ON c.id = l.team_channel_id
        WHERE l.org_user_id = $1
          AND l.invited_phone IS NULL AND l.invited_email IS NULL
     ORDER BY l.created_at DESC`,
      [orgUserId],
    );
  }

  /** M11A — the applicant's own view. Returns ONLY their own request. */
  async myJoinRequest(applicantUserId: string): Promise<{
    status: 'pending' | 'approved' | 'declined'; org_name: string | null; team_name: string | null;
    decided_at: string | null;
  } | null> {
    const row = await this.db.qOne<{
      status: 'pending' | 'approved' | 'declined'; org_name: string | null;
      team_name: string | null; decided_at: Date | null;
    }>(
      // TENANCY: scoped to the CALLER's own request. Without
      // `r.applicant_user_id = $1` this returns the newest join request in the
      // system to anyone who asks — org name and team included.
      // B-392: THE COMPANY'S NAME, NOT THE FOUNDER'S — same rule as
      // resolveReferralLink. This one still showed the owner's personal
      // display_name on the Approval Status screen while the Join screen showed
      // the workspace name for the very same application.
      `SELECT r.status, COALESCE(w.name, u.display_name) AS org_name,
              CASE WHEN c.archived_at IS NULL THEN c.name END AS team_name, r.decided_at
         FROM public.enterprise_join_requests r
         JOIN public.users u ON u.id = r.org_user_id
    LEFT JOIN public.org_workspaces w ON w.owner_user_id = r.org_user_id
    LEFT JOIN public.department_channels c ON c.id = r.team_channel_id
        WHERE r.applicant_user_id = $1
     ORDER BY r.created_at DESC
        LIMIT 1`,
      [applicantUserId],
    );
    if (!row) return null;
    return {
      status: row.status,
      // Even here the org name is only revealed once they have actually applied
      // to it — this row IS their application, so it is their own data.
      org_name: row.org_name, team_name: row.team_name,
      decided_at: row.decided_at ? row.decided_at.toISOString() : null,
    };
  }

  /** A11 — the admin inbox. */
  async listPendingRequests(orgUserId: string, department?: string | null): Promise<Array<{
    id: string; applicant_user_id: string; applicant_name: string | null;
    applicant_phone: string | null; applicant_email: string | null;
    referrer_name: string | null; team_name: string | null; message: string | null;
    created_at: string;
  }>> {
    return this.db.q(
      // A11: "Show applicant name, mobile, email, referrer, Enterprise and exact
      // team requested."
      // TENANCY: `r.org_user_id = $1` is what stops every admin seeing every
      // Enterprise's applicants — name, phone, email, team and message.
      //
      // BRANCH SCOPE: OrgManagerContext.department is documented as a FORCED
      // FILTER that services apply (attendance and incidents both do). Dropping
      // it let a department-scoped manager approve requests for branches they do
      // not govern — page 10 rule 2, "Lower Admins cannot manage parents,
      // siblings or unrelated branches". A NULL department means whole-org.
      // This is the branch half of A11's routing rule; deriving routing from the
      // channel HIERARCHY itself is still owed (logged in the plan doc).
      `SELECT r.id, r.applicant_user_id, r.applicant_name, r.applicant_phone, r.applicant_email,
              ref.display_name AS referrer_name,
              CASE WHEN c.archived_at IS NULL THEN c.name END AS team_name, r.message, r.created_at
         FROM public.enterprise_join_requests r
    LEFT JOIN public.users ref ON ref.id = r.referrer_user_id
    LEFT JOIN public.department_channels c ON c.id = r.team_channel_id
        WHERE r.org_user_id = $1 AND r.status = 'pending'
          -- A TEAMLESS request must fall THROUGH the branch filter, not be
          -- swallowed by it. c.department is NULL when there is no team, and
          -- NULL = 'Ops' is NULL, so the naive form hid every teamless request
          -- from every scoped manager — which today is 100% of them, since no
          -- link can carry a team yet. An unrouted request belongs in every
          -- manager's inbox, not nobody's.
          -- (No backticks in this comment: it is inside a JS template literal.)
          --
          -- The EFFECTIVE department, not the raw column. Testing
          -- r.team_channel_id IS NULL asked "is there a team id", while c is
          -- archive-excluded — so an ARCHIVED team was neither routed nor
          -- unrouted and the request vanished from every scoped manager's
          -- inbox. COALESCE folds all three unresolvable cases (no team,
          -- deleted channel, archived channel) into "unrouted", which the
          -- comment above says belongs in every manager's inbox.
          -- decideJoinRequest MUST use the identical expression, or a manager
          -- can decide what they cannot see.
          AND ($2::text IS NULL
               OR COALESCE(CASE WHEN c.archived_at IS NULL THEN c.department END, $2) = $2)
     ORDER BY r.created_at DESC`,
      [orgUserId, department ?? null],
    );
  }

  /**
   * A11 — "Admin decision actions are exactly Approve or Decline" and "If two
   * Admins act, the first decision wins and the second receives a conflict
   * state."
   *
   * FIRST DECISION WINS is enforced by a single CONDITIONAL UPDATE judged on
   * whether a row came back — never read-then-write, which would let both
   * admins read 'pending' and both proceed. Same technique that makes
   * provider_invite_codes single-use under a race.
   */
  async decideJoinRequest(
    orgUserId: string, adminUserId: string, requestId: string, decision: 'approved' | 'declined',
    department?: string | null,
  ): Promise<{ok: true; decision: 'approved' | 'declined'}> {
    // ONE TRANSACTION. The claim and the membership grant must succeed or fail
    // together.
    //
    // Previously the claim committed on its own and the INSERT ran after. The
    // INSERT can fail on a DIFFERENT unique index — org_members_one_active_agency
    // is UNIQUE(member_user_id) WHERE status='active', so `ON CONFLICT
    // (org_user_id, member_user_id)` does NOT absorb it — leaving the request
    // permanently 'approved' with no membership row: the applicant's M11A screen
    // reads "Access approved" forever with zero access, and a retry hits the
    // conditional claim, matches nothing, and 409s. Same reason redeemInviteCode
    // wraps its claim + seed.
    const claimed = await this.db.withTransaction(async tx => {
      let scope: SeedScope = {kind: 'orgWide'};
      const row = await tx.qOne<{applicant_user_id: string; team_channel_id: string | null; team_parent_id: string | null}>(
        // The branch forced filter belongs IN the claim, not in a pre-check: a
        // scoped manager must not be able to decide a request they cannot see,
        // and doing it here keeps the whole thing one atomic conditional.
        `UPDATE public.enterprise_join_requests r
            SET status = $3, decided_by = $4, decided_at = NOW(),
                seed_pending_at = CASE WHEN $3 = 'approved' THEN NOW() ELSE seed_pending_at END
          WHERE r.id = $1 AND r.org_user_id = $2 AND r.status = 'pending'
            -- IDENTICAL rule to listPendingRequests' branch filter. The two
            -- drifted: this one resolved the channel without the archive check
            -- while the list excluded archived rows, so a manager scoped to an
            -- archived team's branch could not SEE a request but could still
            -- DECIDE it. Whatever the inbox shows is exactly what may be acted
            -- on.
            AND ($5::text IS NULL OR COALESCE((
                  SELECT CASE WHEN c.archived_at IS NULL THEN c.department END
                    FROM public.department_channels c
                   WHERE c.id = r.team_channel_id), $5) = $5)
          RETURNING r.applicant_user_id, r.team_channel_id,
                    (SELECT l.team_parent_id FROM public.enterprise_referral_links l
                      WHERE l.id = r.link_id) AS team_parent_id`,
        [requestId, orgUserId, decision, adminUserId, department ?? null],
      );
      if (!row) {
        // Either it never existed in this org, or another admin already decided.
        // Distinguish them so the second admin gets the CONFLICT state A11 asks
        // for rather than a bare 404.
        const seen = await tx.qOne<{status: string}>(
          `SELECT status FROM public.enterprise_join_requests WHERE id = $1 AND org_user_id = $2`,
          [requestId, orgUserId],
        );
        if (!seen) throw new NotFoundException('join_request_not_found');
        // STILL PENDING but the claim matched nothing ⇒ it was the BRANCH filter,
        // not another admin. Reporting "already decided" here was a lie that the
        // UI rendered verbatim, corrupting the very A11 semantic the design leans
        // on — and it confirmed a request-id's existence to an out-of-scope
        // manager. 404: from their scope, it is not there.
        if (seen.status === 'pending') throw new NotFoundException('join_request_not_found');
        throw new ConflictException('join_request_already_decided');
      }

      if (decision === 'approved') {
        // Resolve the seed scope AFTER the claim but still INSIDE the tx.
        //
        // "Before the claim" is the usual phrasing of this rule, but what the
        // rule actually needs is the ROLLBACK: the seed runs post-commit and is
        // contractually best-effort, so a dead chain must undo the claim rather
        // than leave a request marked approved with nothing granted. A throw
        // here rolls the claim back exactly as one before it would, and the
        // claim's own RETURNING already carries the team — so this costs no
        // extra query and no extra lock-hold time.
        //
        // The breadcrumb IS available on this lane, contrary to an earlier
        // comment here. It is per-TEAM, not per-person, and a link names
        // exactly one team — so the open multi-use row still carries a usable
        // parent, and the request row already stores `link_id`. Passing null
        // left the delete door open on the approval lane: a deleted team there
        // routed straight back to the org-wide grant this change exists to end.
        scope = await this.resolveSeedScopeInTx(
          tx, orgUserId, row.team_channel_id, row.team_parent_id ?? null);
        if (scope.kind === 'dead') {
          throw new ConflictException('team_channel_unavailable_reinvite');
        }
        // 'employee' — an Enterprise workspace joiner is back-office staff,
        // never a deployable CPO (the A7.3 / rule-7 distinction).
        await this.grantMembership(tx, orgUserId, row.applicant_user_id, 'employee', null, adminUserId);
      }
      return {...row, scope};
    });

    // M11A: "Approved creates Member access IN THE REFERRED TEAM using Admin
    // settings." Deliberately AFTER the commit, because it routes through
    // DepartmentService.addMember (which uses the pooled connection, not this
    // tx) — and going through addMember is non-negotiable: it is what enqueues
    // the rekey intent, without which the member holds no group key.
    //
    // The trade-off is stated rather than hidden: the CLAIM and the MEMBERSHIP
    // row are atomic (that pair is what "approved" means, and a torn write there
    // is unrecoverable). The channel seed is idempotent and self-healing, so a
    // failure here leaves a real member whose channels can be re-seeded, not a
    // request stuck in a state no retry can leave.
    //
    // EVERYTHING AFTER THE COMMIT IS BEST-EFFORT — that is the whole basis for
    // running the seed out here. The per-channel try/catch was not enough: the
    // candidate query, the audit write and the notification all sat unguarded,
    // so a failure in any of them threw AFTER the membership row committed. The
    // admin saw a 500, retried into a 409, and the decision ended up real but
    // unaudited and unannounced — a smaller sibling of the torn state this
    // design exists to prevent.
    if (decision === 'approved') {
      await this.seedApprovedMemberChannels(
        orgUserId, claimed.applicant_user_id, adminUserId,
        claimed.scope.kind === 'scoped' ? {scopeIds: claimed.scope.ids} : undefined,
      ).catch(e => this.log.warn(`approved-member channel seed failed: ${(e as Error)?.message}`));
    }
    // Page 10 rule 4 — the decision is audited either way, including a decline
    // ("the decision remains in the Admin record", M11A).
    // Best-effort, and NOT allowed to gate the notification below it: an audit
    // failure used to swallow the applicant's "you were approved" message.
    await this.audit.log(orgUserId, adminUserId, `enterprise.join.${decision}`, {
      targetKind: 'join_request', targetId: requestId,
      metadata: {applicant_user_id: claimed.applicant_user_id, team_channel_id: claimed.team_channel_id},
    }).catch(e => this.log.warn(`join decision audit failed: ${(e as Error)?.message}`));
    // M11A — "The user receives a notification when the request status changes."
    // AFTER the transaction commits: notifying about a decision that then rolled
    // back would be worse than not notifying at all.
    // `.catch` for the SAME reason as its sibling in submitJoinRequest, and for
    // symmetry: `record` swallows its own errors today, so this is belt-and-
    // braces — but "one of the two post-commit notifies is guarded and the other
    // isn't" is the ambiguity that makes a future reader guess which half was
    // deliberate. A throw here would surface as a failed decision to an admin
    // whose decision has already committed.
    await this.push.enterpriseJoinDecided(claimed.applicant_user_id, decision)
      .catch(e => this.log.warn(`join-decision notify failed: ${(e as Error)?.message}`));
    return {ok: true, decision};
  }

  /**
   * THE ONLY WRITER of org_members in this service (join approval AND invite
   * acceptance — one copy, per the duplicate-copy rule). Always called on a
   * transaction handle so the grant commits or rolls back with its claim.
   *
   * Existing row? Then this is a REINSTATEMENT, and it must not silently
   * restore — or upgrade — whatever role the row had.
   *
   * `DO UPDATE SET status='active'` left member_role untouched, so a
   * deliberately-REMOVED 'manager' came back as a manager — full
   * OrgManagerGuard powers, including approving further joins — and a removed
   * 'cpo' came back as a deployable officer. Neither is what an admin thinks
   * they are clicking. And the mirror image: a MANAGER invite accepted by a
   * removed employee must not silently re-type them either — role changes go
   * through the roster role endpoint, never through a join/accept side door.
   * So: reinstatement is allowed only when both the existing row and the grant
   * are plain 'employee'; anything else is 409 member_exists_use_roster_status.
   */
  private async grantMembership(
    tx: Tx, orgUserId: string, memberUserId: string,
    role: 'employee' | 'manager', department: string | null, grantedBy: string,
  ): Promise<void> {
    // An org cannot grant membership to ITSELF (a self-row the roster would
    // then offer to suspend). Both lanes (approve AND accept) share these
    // refusals by construction — this is the single writer.
    if (orgUserId === memberUserId) {
      throw new ConflictException('cannot_join_own_workspace');
    }
    // Phase B (founder-approved 2026-08-09) — the workspace-owner refusal is
    // GONE: an owner may hold one membership elsewhere (the one-active-org
    // unique index still bounds it). The split-identity concern it guarded is
    // resolved structurally instead: /auth/me's four-arm primary-org
    // precedence keeps an owner resolving to their OWN workspace
    // (account-kind.ts), the additive `workspaces` array names both
    // affiliations, and the client scopes the departmental surface per
    // workspace (activeWorkspace context + org-scoped channel reads).
    const existing = await tx.qOne<{member_role: string; status: string}>(
      `SELECT member_role, status FROM org_members
        WHERE org_user_id = $1 AND member_user_id = $2`,
      [orgUserId, memberUserId],
    );
    // A SUSPENDED row never reinstates through a join lane — suspension is an
    // audited roster state with a window and a reason, and both lanes would
    // otherwise lift it silently (in the invite lane the minting admin cannot
    // even know: the mint response is deliberately match-blind).
    if (existing && existing.status === 'suspended') {
      throw new ConflictException('member_suspended_use_roster_status');
    }
    if (existing && (existing.member_role !== 'employee' || role !== 'employee')) {
      throw new ConflictException('member_exists_use_roster_status');
    }
    try {
      if (existing) {
        await tx.q(
          `UPDATE org_members SET status = 'active'
            WHERE org_user_id = $1 AND member_user_id = $2`,
          [orgUserId, memberUserId],
        );
      } else {
        // department: only a manager grant may carry one (the DB CHECK on the
        // invite row enforces the same rule at rest). This is the first real
        // writer of org_members.department — OrgManagerGuard Path 2 already
        // reads it into the forced branch filter, so a scoped manager invited
        // this way is scoped from their first request.
        await tx.q(
          `INSERT INTO org_members (org_user_id, member_user_id, member_role, department, status, invited_by)
           VALUES ($1, $2, $3, $4, 'active', $5)`,
          [orgUserId, memberUserId, role, role === 'manager' ? department : null, grantedBy],
        );
      }
    } catch (e: unknown) {
      /**
       * vs2 item 4 — TWO indexes can raise 23505 here now, and they mean
       * different things:
       *
       *   org_members_one_active_cpo  — this person is already an active CPO
       *     somewhere else. Still refused, and 'already_active_in_another_org'
       *     is still the honest message.
       *   org_members_one_per_org     — a row for this (member, org) pair
       *     already exists. That is NOT a second-org conflict; it is a repeat
       *     grant, which `grantMembership` handles by reactivating. Reaching it
       *     here means a race, and reporting it as "active in another org"
       *     would send the user hunting for an org they are not in.
       */
      if ((e as {code?: string})?.code === '23505') {
        const detail = String((e as {constraint?: string})?.constraint ?? '');
        // `org_members_pkey` — NOT a bespoke index. (org_user_id,
        // member_user_id) is the table's PRIMARY KEY, so a duplicate pair
        // raises under that name; matching only a hand-added index name
        // meant this branch could never fire and the user was still told
        // they were active in an org they are not in.
        if (/one_per_org|org_members_pkey/.test(detail)) {
          throw new ConflictException('already_a_member_of_this_org');
        }
        throw new ConflictException('already_active_in_another_org');
      }
      throw e;
    }
  }

  // ─── Item E — member invites by phone/email (A5+M5, Slack-style) ──────────
  //
  // An invite is a BOUND, SINGLE-USE, auto-approve variant row on
  // enterprise_referral_links. No pre-acceptance org_members row ever exists —
  // the M11A "pending sees nothing" property holds for invitees exactly as it
  // does for applicants, because until acceptance there is nothing to see with.

  /**
   * A5-inv — an admin invites a specific person by phone OR email.
   *
   * The response is BYTE-IDENTICAL whether or not the contact matches an
   * existing account: the mint must not be an existence oracle for phone
   * numbers or emails. The only observable difference is the invitee's own
   * notification, which by definition only they receive.
   */
  async createMemberInvite(
    orgUserId: string, managerUserId: string, managerDepartment: string | null,
    input: {
      contact_phone?: string; contact_email?: string; invited_name?: string;
      team_channel_id?: string; invited_role?: 'employee' | 'manager';
      invited_department?: string; expires_in_days?: number;
    },
  ): Promise<{code: string; expires_at: string | null}> {
    const phone = input.contact_phone?.trim() || null;
    const email = input.contact_email?.trim() || null;
    if (!phone && !email) throw new BadRequestException('invite_contact_required');
    if (phone && email) throw new BadRequestException('invite_one_contact_only');
    // E.164 or refuse. The server cannot know the inviter's country, so it
    // never guesses a prefix — the client normalises (B-154) before calling.
    if (phone && !/^\+[0-9]{7,15}$/.test(phone)) {
      throw new BadRequestException('invite_phone_not_e164');
    }
    const role = input.invited_role ?? 'employee';
    const dept = input.invited_department?.trim() || null;
    if (dept && role !== 'manager') {
      throw new BadRequestException('invite_department_requires_manager_role');
    }
    // A branch-scoped manager must not be able to mint their way past their own
    // scope: no admin grants, and any team they attach must be in their branch.
    // (A branchless employee invite stays allowed — the same scope rule as
    // decideJoinRequest, where a scoped manager may decide a branchless
    // request.)
    if (managerDepartment != null && role === 'manager') {
      throw new ForbiddenException('scoped_manager_cannot_grant_admin');
    }
    /**
     * G6 (founder, 2026-08-19) — "When adding Admins, it should be organization
     * specific only."
     *
     * A TEAMLESS invite seeds the joiner across the whole workspace
     * (`resolveSeedScopeInTx` returns `{kind:'orgWide'}` when neither the
     * channel nor the parent breadcrumb is set), which with more than one root
     * is a grant over every organisation in it. For an EMPLOYEE that reach is
     * the admin's call. For a MANAGER it is exactly the "admins seeing other
     * organizations" the founder asked us to stop — and it was the DEFAULT,
     * because the form starts with no team selected.
     *
     * ⚠️ THE SERVER RULE IS THE REAL BOUNDARY, and that is why it exists here
     * as well as on the form. The client pre-flight reads `workspace_tenant`
     * from `listManagedChannels`, so ONE failed list load left `serverTenant`
     * undefined, the rule silently off, and a whole-workspace manager minted —
     * and an older APK bypassed it entirely. A constraint enforced only by the
     * screen that happens to have loaded is advisory, not a constraint.
     *
     * WORKSPACE TENANT ONLY: an agency has exactly one organisation, so the
     * rule would have no meaning there and would only block a legitimate
     * org-wide manager invite.
     *
     * AND ONLY WHEN THERE IS SOMETHING TO PICK. On a clean workspace with no
     * channels yet, "name an organisation" is unsatisfiable: the picker renders
     * "No organisations yet", and refusing here would make the first co-admin
     * of a brand-new workspace impossible to invite. With zero organisations
     * there are also no OTHER organisations to leak into, which is the entire
     * point of the rule. `mintable_by_me` is deliberately NOT consulted — this
     * asks whether a team COULD be named at all, not whether this particular
     * minter may name each one; that refusal is `assertMintableTeam`'s job and
     * it produces its own, more specific error.
     */
    if (role === 'manager' && !input.team_channel_id
        && await this.department.isWorkspaceTenant(orgUserId)) {
      const anyTeam = await this.db.qOne<{n: number}>(
        `SELECT 1 AS n FROM public.department_channels
          WHERE org_id = $1 AND archived_at IS NULL AND NOT is_broadcast
            AND post_mode <> 'announcement'
          LIMIT 1`,
        [orgUserId],
      );
      if (anyTeam) {throw new BadRequestException('manager_invite_requires_team');}
    }
    let teamParentId: string | null = null;
    if (input.team_channel_id) {
      teamParentId = (await this.assertMintableTeam(
        orgUserId, input.team_channel_id, managerDepartment)).parentId;
    }
    // The one-open-invite-per-contact partial index cannot see expiry (NOW()
    // is not immutable), so an EXPIRED open invite for the same contact is
    // auto-revoked here rather than wedging every future mint on a corpse.
    await this.db.q(
      `UPDATE public.enterprise_referral_links
          SET revoked_at = NOW()
        WHERE org_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at IS NOT NULL AND expires_at <= NOW()
          AND (($2::text IS NOT NULL AND invited_phone = $2)
            OR ($3::text IS NOT NULL AND lower(invited_email) = lower($3)))`,
      [orgUserId, phone, email],
    );
    // A STILL-VALID open invite for this contact: adopt it BEFORE the cap
    // check (adoption creates nothing, so the cap has no business refusing it —
    // edge-case review). Adoption is config-checked, never blind.
    const adopted = await this.adoptOpenInvite(orgUserId, phone, email, role, input.team_channel_id ?? null, dept);
    if (adopted) {return adopted;}
    // Cap open invites per org — a runaway mint loop should hit a wall the
    // admin can see, not a silent pile of live capabilities.
    const open = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n FROM public.enterprise_referral_links
        WHERE org_user_id = $1
          AND (invited_phone IS NOT NULL OR invited_email IS NOT NULL)
          AND accepted_at IS NULL AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [orgUserId],
    );
    if (Number(open?.n ?? 0) >= 50) throw new ConflictException('invite_cap_reached');
    const code = this.mintCode();
    const days = Math.min(Math.max(input.expires_in_days ?? 7, 1), 90);
    let row: {id: string; code: string; expires_at: Date | null} | null;
    try {
      row = await this.db.qOne<{id: string; code: string; expires_at: Date | null}>(
        `INSERT INTO public.enterprise_referral_links
           (code, org_user_id, referrer_user_id, team_channel_id, team_parent_id,
            expires_at, created_by,
            invited_phone, invited_email, invited_name, invited_role, invited_department)
         VALUES ($1, $2, $3, $4, $11, NOW() + ($5 || ' days')::interval, $3, $6, $7, $8, $9, $10)
         RETURNING id, code, expires_at`,
        [code, orgUserId, managerUserId, input.team_channel_id ?? null, String(days),
         phone, email, input.invited_name?.trim() || null, role, dept, teamParentId],
      );
    } catch (e: unknown) {
      if ((e as {code?: string})?.code === '23505') {
        // Race: another mint for the same contact landed between the adopt
        // check and this INSERT. Same adoption rules apply.
        const raced = await this.adoptOpenInvite(orgUserId, phone, email, role, input.team_channel_id ?? null, dept);
        if (raced) {return raced;}
        // Not the contact index — an (astronomically rare) code collision.
      }
      throw e;
    }
    if (!row) throw new BadRequestException('invite_create_failed');
    // SILENT MATCH: if the contact already has an account, wake them. This must
    // never reflect back into the response (existence oracle) — the admin's
    // view is identical matched or unmatched. (The two extra awaits make the
    // matched path marginally slower — a timing channel we accept; the BYTES
    // are what the contract pins.)
    const matched = await this.db.qOne<{id: string}>(
      phone
        // Legacy rows may store phone_e164 without the plus; the invite side is
        // always E.164 (DB CHECK), so compare both spellings.
        ? `SELECT id FROM public.users
            WHERE (phone_e164 = $1 OR '+' || phone_e164 = $1) AND deleted_at IS NULL`
        : `SELECT id FROM public.users
            WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL`,
      [phone ?? email],
    );
    if (matched) {
      await this.push.enterpriseInviteReceived(matched.id)
        .catch(e => this.log.warn(`invite-received notify failed: ${(e as Error)?.message}`));
    }
    // PRIVACY: contact_kind only — never the raw phone/email — in audit
    // metadata. The contact is retrievable by an authorised admin via the
    // invite list; the audit log is a different, wider-read surface.
    // BEST-EFFORT (stated trade-off, critic 2026-08-08): the capability is
    // already live (row inserted, matched invitee pushed), so an audit blip
    // must not 500 a mint that cannot be retried — the retry would adopt the
    // row and deliberately not re-audit, leaving it unaudited FOREVER. A
    // logged warn beats a permanently audit-less live invite.
    await this.audit.log(orgUserId, managerUserId, 'enterprise.invite.create', {
      targetKind: 'referral_link', targetId: row.id,
      metadata: {
        contact_kind: phone ? 'phone' : 'email',
        team_channel_id: input.team_channel_id ?? null,
        invited_role: role, expires_in_days: days,
      },
    }).catch(e => this.log.warn(`invite-create audit failed: ${(e as Error)?.message}`));
    return {code: row.code, expires_at: row.expires_at ? row.expires_at.toISOString() : null};
  }

  /**
   * Adopt an existing OPEN, unexpired invite for the same contact — but only
   * when its role and team MATCH what the admin just configured. Blind
   * adoption silently handed back a code carrying the OLD settings (an
   * employee re-mint could return a live MANAGER credential) while the UI said
   * "invite created" with the new ones. A mismatch is an honest 409: the admin
   * must revoke the old invite first, which is also the audited path.
   */
  private async adoptOpenInvite(
    orgUserId: string, phone: string | null, email: string | null,
    role: 'employee' | 'manager', teamChannelId: string | null,
    department: string | null,
  ): Promise<{code: string; expires_at: string | null} | null> {
    const existing = await this.db.qOne<{
      code: string; expires_at: Date | null;
      invited_role: string; team_channel_id: string | null; invited_department: string | null;
    }>(
      `SELECT code, expires_at, invited_role, team_channel_id, invited_department
         FROM public.enterprise_referral_links
        WHERE org_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (($2::text IS NOT NULL AND invited_phone = $2)
            OR ($3::text IS NOT NULL AND lower(invited_email) = lower($3)))`,
      [orgUserId, phone, email],
    );
    if (!existing) {return null;}
    // EVERY authority-bearing field, not just role+team: invited_department is
    // the branch scope OrgManagerGuard enforces, so adopting across a scope
    // change is the same silently-wrong-credential class one field over.
    if (existing.invited_role !== role || existing.team_channel_id !== teamChannelId
        || existing.invited_department !== department) {
      throw new ConflictException('invite_exists_for_contact');
    }
    // Same config — from the admin's side the outcome ("this person has a live
    // invite with these settings") is identical, same shape as
    // submitJoinRequest's double-tap rule. No re-audit, no re-notify.
    return {code: existing.code, expires_at: existing.expires_at ? existing.expires_at.toISOString() : null};
  }

  /** The admin's open/settled invites. Branch-filtered with the same COALESCE
   *  rule as decideJoinRequest: a scoped manager sees branchless invites and
   *  their own branch's, never another branch's. */
  async listMemberInvites(orgUserId: string, department?: string | null): Promise<Array<{
    code: string; contact: string; contact_kind: 'phone' | 'email';
    invited_name: string | null; invited_role: string; team_name: string | null;
    status: 'pending' | 'accepted' | 'expired' | 'revoked';
    expires_at: string | null; created_at: string;
  }>> {
    return this.db.q(
      `SELECT l.code,
              COALESCE(l.invited_phone, l.invited_email) AS contact,
              CASE WHEN l.invited_phone IS NOT NULL THEN 'phone' ELSE 'email' END AS contact_kind,
              l.invited_name, l.invited_role,
              CASE WHEN c.archived_at IS NULL THEN c.name END AS team_name,
              CASE WHEN l.accepted_at IS NOT NULL THEN 'accepted'
                   WHEN l.revoked_at IS NOT NULL THEN 'revoked'
                   WHEN l.expires_at IS NOT NULL AND l.expires_at <= NOW() THEN 'expired'
                   ELSE 'pending' END AS status,
              l.expires_at, l.created_at
         FROM public.enterprise_referral_links l
    LEFT JOIN public.department_channels c ON c.id = l.team_channel_id
        WHERE l.org_user_id = $1
          AND (l.invited_phone IS NOT NULL OR l.invited_email IS NOT NULL)
          AND ($2::text IS NULL OR COALESCE(
                CASE WHEN c.archived_at IS NULL THEN c.department END, $2) = $2)
     ORDER BY (l.accepted_at IS NULL AND l.revoked_at IS NULL
               AND (l.expires_at IS NULL OR l.expires_at > NOW())) DESC,
              l.created_at DESC
        LIMIT 100`,
      [orgUserId, department ?? null],
    );
  }

  /** Revoke an OPEN invite. Already accepted is a distinct 409 — the person is
   *  a member now, and pretending the revoke worked would leave the admin
   *  believing access was withdrawn when it was not (removal goes through the
   *  roster). */
  async revokeMemberInvite(
    orgUserId: string, managerUserId: string, code: string, department?: string | null,
  ): Promise<{ok: true}> {
    const c = code.trim().toUpperCase();
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.enterprise_referral_links l
          SET revoked_at = NOW()
        WHERE l.code = $1 AND l.org_user_id = $2
          AND (l.invited_phone IS NOT NULL OR l.invited_email IS NOT NULL)
          AND l.accepted_at IS NULL AND l.revoked_at IS NULL
          AND ($3::text IS NULL OR COALESCE((
                SELECT CASE WHEN ch.archived_at IS NULL THEN ch.department END
                  FROM public.department_channels ch
                 WHERE ch.id = l.team_channel_id), $3) = $3)
        RETURNING l.id`,
      [c, orgUserId, department ?? null],
    );
    if (!row) {
      const seen = await this.db.qOne<{accepted_at: Date | null}>(
        `SELECT accepted_at FROM public.enterprise_referral_links
          WHERE code = $1 AND org_user_id = $2
            AND (invited_phone IS NOT NULL OR invited_email IS NOT NULL)`,
        [c, orgUserId],
      );
      if (seen?.accepted_at) throw new ConflictException('invite_already_accepted');
      throw new NotFoundException('invite_not_found');
    }
    // BEST-EFFORT for the same reason as the mint audit: the revoke is already
    // durable, and a retry of a committed-but-unaudited revoke 404s — a 500
    // here would tell the admin the revoke failed when it held.
    await this.audit.log(orgUserId, managerUserId, 'enterprise.invite.revoke', {
      targetKind: 'referral_link', targetId: row.id,
      metadata: {code: c},
    }).catch(e => this.log.warn(`invite-revoke audit failed: ${(e as Error)?.message}`));
    return {ok: true};
  }

  /**
   * The INVITEE's own view: open invites addressed to the caller's verified
   * phone or account email. The invite is addressed to them, so naming the org
   * and team here is correct — this is the surfacing half of the email
   * trade-off.
   *
   * THE CODE IS RETURNED ONLY FOR PHONE MATCHES. The phone is OTP-verified, so
   * a phone match IS the binding. An account's EMAIL is never verified in this
   * system — returning the code on an email string-match handed the acceptance
   * credential to whoever registered that address first (critic finding,
   * 2026-08-08: register hr@corp.com → GET /invites/me → manager code). Email
   * invites surface WITHOUT the code; the admin shares it out-of-band, which
   * is the stated delivery design.
   *
   * The org_members NOT EXISTS mirrors those arms of the accept pre-check
   * EXACTLY: a cohort whose refusal would otherwise leak roster history —
   * already active, suspended, a non-employee roster history, or a manager
   * invite over an existing row — is excluded, because surfacing an invite the
   * caller can never clear is a permanent nagging CTA (the admin revoking it
   * is the real resolution). The one cohort that legitimately re-enters this
   * way — a REMOVED employee invited back as an employee — keeps surfacing.
   *
   * B-413/Phase B — every refusal the accept still runs into is SURFACED, not
   * hidden: rows the caller cannot accept (active membership in another org —
   * the one-active-org rule) come back `acceptable: false` with the reason
   * instead of being dropped. The Workspace Hub lists them as informational
   * rows — never a CTA — which is how "another admin invited me and nothing
   * showed anywhere" stops happening. Workspace OWNERS' rows are acceptable
   * since Phase B (founder-approved 2026-08-09).
   */
  async myInvites(userId: string): Promise<Array<{
    code: string | null; org_name: string | null; team_name: string | null;
    invited_role: 'employee' | 'manager'; expires_at: string | null;
    acceptable: boolean;
    blocked_reason?: 'already_active_in_another_org';
  }>> {
    const me = await this.db.qOne<{phone_e164: string | null; email: string | null}>(
      `SELECT phone_e164, email FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!me || (!me.phone_e164 && !me.email)) return [];

    const rows = await this.db.q<{
      code: string | null; org_name: string | null; team_name: string | null;
      invited_role: 'employee' | 'manager'; expires_at: string | null;
    }>(
      // The plus-prefix fallback covers callers whose stored phone_e164
      // predates E.164 normalisation; invited_phone is always E.164 (DB CHECK).
      `SELECT CASE WHEN l.invited_phone IS NOT NULL THEN l.code END AS code,
              COALESCE(w.name, u.display_name) AS org_name,
              CASE WHEN c.archived_at IS NULL THEN c.name END AS team_name,
              l.invited_role, l.expires_at
         FROM public.enterprise_referral_links l
         JOIN public.users u ON u.id = l.org_user_id
    LEFT JOIN public.org_workspaces w ON w.owner_user_id = l.org_user_id
    LEFT JOIN public.department_channels c ON c.id = l.team_channel_id
        WHERE l.accepted_at IS NULL AND l.revoked_at IS NULL
          AND (l.expires_at IS NULL OR l.expires_at > NOW())
          AND (($1::text IS NOT NULL AND (l.invited_phone = $1 OR l.invited_phone = '+' || $1))
            OR ($2::text IS NOT NULL AND lower(l.invited_email) = lower($2)))
          AND NOT EXISTS (
            SELECT 1 FROM public.org_members m
             WHERE m.org_user_id = l.org_user_id AND m.member_user_id = $3
               AND (m.status IN ('active', 'suspended')
                 OR m.member_role <> 'employee'
                 OR l.invited_role <> 'employee'))
     ORDER BY l.created_at DESC
        LIMIT 20`,
      [me.phone_e164, me.email, userId],
    );
    /**
     * vs2 item 4 — every surviving row IS acceptable.
     *
     * The "active elsewhere" probe that used to sit here mirrored a refusal the
     * accept no longer performs (see resolveReferralLink above). Keeping it
     * greyed the CTA in the hub and dropped the row entirely in
     * ApprovalStatusScreen for the exact persona this item exists for, while
     * the accept behind both surfaces would have succeeded. The per-invite
     * NOT EXISTS in the query above still drops invites from an org the caller
     * is already in, which is the one refusal that remains real.
     */
    return rows.map(r => ({...r, acceptable: true}));
  }

  /**
   * M5-inv — accept an invite. Auto-approve: one transaction claims the invite
   * and grants membership; the request row is closed (or created already
   * approved) so M11A reads "approved" and the audit trail has its anchor.
   *
   * EVERY pre-claim failure class — unknown code, revoked, already accepted,
   * expired, phone-binding mismatch, minter no longer authorised, self-accept
   * by the org account, prior roster history (removed non-employee, suspended,
   * or a role-mismatched grant) — returns the ONE safe message. Distinguishing
   * them would let a code holder probe which failure they hit (and, on an
   * email invite any code holder can attempt, leak the target's membership
   * history). The deliberate exception is the caller's OWN state, theirs to
   * know: already active in THIS org → 409 already_a_member (and active in a
   * DIFFERENT org → the unique index's already_active_in_another_org at
   * grant time). Phase B removed the workspace-owner refusal.
   *
   * PHONE binding is ENFORCED (the number is OTP-verified). EMAIL binding is
   * SURFACING-ONLY — emails are unverified in this system, so possession of
   * the single-use, revocable code is the acceptance credential. Stated
   * trade-off, not an accident.
   */
  async acceptInvite(userId: string, code: string): Promise<{ok: true}> {
    const invalid = () => new BadRequestException('invite_invalid_or_expired');
    const c = code.trim().toUpperCase();
    const inv = await this.db.qOne<{
      id: string; org_user_id: string; created_by: string | null;
      invited_phone: string | null; invited_email: string | null;
      invited_role: 'employee' | 'manager'; invited_department: string | null;
      team_channel_id: string | null; team_department: string | null;
      // The mint-time breadcrumb. Without it a DELETED team is byte-identical
      // to "no team", which routes to the org-wide seed and silently widens a
      // branch-scoped grant through the delete door.
      team_parent_id: string | null;
      accepted_at: Date | null; revoked_at: Date | null; expires_at: Date | null;
    }>(
      `SELECT l.id, l.org_user_id, l.created_by, l.invited_phone, l.invited_email,
              l.invited_role, l.invited_department, l.team_channel_id, l.team_parent_id,
              CASE WHEN ch.archived_at IS NULL THEN ch.department END AS team_department,
              l.accepted_at, l.revoked_at, l.expires_at
         FROM public.enterprise_referral_links l
    LEFT JOIN public.department_channels ch ON ch.id = l.team_channel_id
        WHERE l.code = $1 AND (l.invited_phone IS NOT NULL OR l.invited_email IS NOT NULL)`,
      [c],
    );
    if (!inv || inv.accepted_at || inv.revoked_at
        || (inv.expires_at && inv.expires_at.getTime() <= Date.now())) {
      throw invalid();
    }
    if (inv.invited_phone) {
      const me = await this.db.qOne<{phone_e164: string | null}>(
        `SELECT phone_e164 FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      const mine = me?.phone_e164 ?? '';
      if (mine !== inv.invited_phone && `+${mine}` !== inv.invited_phone) throw invalid();
    }
    // An org cannot hire ITSELF. A manager can trivially mint the founder's own
    // number ("Pick from contacts" → the boss); accepting would write an
    // org_members(X, X) self-row that the roster then offers to suspend/remove.
    // Safe message — to the org account this invite simply is not valid.
    if (userId === inv.org_user_id) throw invalid();
    // The MINTER must still be authorised: a demoted or removed manager's
    // outstanding invites die with their authority. (The org owner mints as
    // themselves and cannot be demoted.)
    if (!inv.created_by) throw invalid();
    const minter = inv.created_by;
    if (minter !== inv.org_user_id) {
      const still = await this.db.qOne<{ok: number}>(
        `SELECT 1 AS ok FROM org_members
          WHERE org_user_id = $1 AND member_user_id = $2
            AND member_role = 'manager' AND status = 'active'`,
        [inv.org_user_id, minter],
      );
      if (!still) throw invalid();
    }
    // Phase B (founder-approved 2026-08-09) — the workspace-owner pre-check is
    // GONE; owners accept like anyone else. grantMembership (the single
    // membership writer) carries the remaining invariants: no self-rows, no
    // silent reinstatement, and the one-active-org unique index still bounds
    // everyone to a single membership.
    const mem = await this.db.qOne<{member_role: string; status: string}>(
      `SELECT member_role, status FROM public.org_members
        WHERE org_user_id = $1 AND member_user_id = $2`,
      [inv.org_user_id, userId],
    );
    if (mem?.status === 'active') throw new ConflictException('already_a_member');
    // Any OTHER roster history (removed non-employee, suspended anything, a
    // manager invite over an old employee row) is refused by grantMembership
    // INSIDE the tx with a distinguishable 409 — which, on an email invite any
    // code holder can attempt, would leak the target's membership history. So
    // the same rules are applied HERE, pre-claim, behind the ONE safe message;
    // the in-tx refusal remains as the race backstop.
    if (mem && (mem.member_role !== 'employee' || inv.invited_role !== 'employee'
        || mem.status === 'suspended')) {
      throw invalid();
    }

    // Returned OUT of the transaction rather than assigned to an outer
    // variable: a closure assignment defeats TypeScript's narrowing, so the
    // post-commit read would not see the scoped case at all.
    const scope = await this.db.withTransaction(async tx => {
      // BEFORE the claim, on purpose — see resolveSeedScopeInTx. A dead chain
      // must roll back rather than consume the invite.
      const resolved = await this.resolveSeedScopeInTx(
        tx, inv.org_user_id, inv.team_channel_id, inv.team_parent_id ?? null,
        inv.invited_role === 'manager');
      if (resolved.kind === 'dead') {
        throw new ConflictException('team_channel_unavailable_reinvite');
      }
      // FIRST ACCEPT WINS — a conditional claim, never read-then-write, same
      // technique as decideJoinRequest and provider_invite_codes. The pre-tx
      // reads above are UX; this UPDATE is the authority.
      const claim = await tx.qOne<{id: string}>(
        `UPDATE public.enterprise_referral_links
            SET accepted_by = $2, accepted_at = NOW()
          WHERE code = $1 AND accepted_at IS NULL AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > NOW())
          RETURNING id`,
        [c, userId],
      );
      if (!claim) throw invalid();
      // M11A reads myJoinRequest — close any open request to THIS org as
      // approved, else record one born-approved, so the status screen and the
      // admin record agree on what happened. Inserting 'approved' cannot trip
      // the one-open partial index (it only covers 'pending').
      // seed_pending_at is stamped on BOTH arms, in-tx. A marker written after
      // the commit would be swallowed by the very catch it compensates for.
      const closed = await tx.qOne<{id: string}>(
        `UPDATE public.enterprise_join_requests
            SET status = 'approved', decided_by = $3, decided_at = NOW(),
                seed_pending_at = NOW()
          WHERE org_user_id = $1 AND applicant_user_id = $2 AND status = 'pending'
          RETURNING id`,
        [inv.org_user_id, userId, minter],
      );
      if (!closed) {
        await tx.q(
          `INSERT INTO public.enterprise_join_requests
             (org_user_id, applicant_user_id, link_id, team_channel_id,
              status, decided_by, decided_at, seed_pending_at)
           VALUES ($1, $2, $3, $4, 'approved', $5, NOW(), NOW())`,
          [inv.org_user_id, userId, inv.id, inv.team_channel_id, minter],
        );
      }
      // Role and branch come from the INVITE — the admin set them at mint.
      // 23505 here (active elsewhere) rolls the whole tx back, so the claim
      // reopens and the invite survives the caller's failed attempt.
      await this.grantMembership(
        tx, inv.org_user_id, userId, inv.invited_role,
        inv.invited_department, minter,
      );
      return resolved;
    });

    // Post-commit, ALL best-effort — same contract as decideJoinRequest: the
    // membership is real once the tx commits; nothing after it may 500 the
    // acceptance.
    await this.seedApprovedMemberChannels(
      inv.org_user_id, userId, minter,
      {
        asManager: inv.invited_role === 'manager',
        ...(scope.kind === 'scoped' ? {scopeIds: scope.ids} : {}),
      },
    ).catch(e => this.log.warn(`invited-member channel seed failed: ${(e as Error)?.message}`));
    await this.audit.log(inv.org_user_id, userId, 'enterprise.invite.accept', {
      targetKind: 'referral_link', targetId: inv.id,
      metadata: {
        contact_kind: inv.invited_phone ? 'phone' : 'email',
        invited_role: inv.invited_role,
      },
    }).catch(e => this.log.warn(`invite-accept audit failed: ${(e as Error)?.message}`));
    // The invitee's own wake reuses the join-approved kind — to the client the
    // outcome IS an approval (M11A shows the same screen either way).
    await this.push.enterpriseJoinDecided(userId, 'approved')
      .catch(e => this.log.warn(`invite-accept notify failed: ${(e as Error)?.message}`));
    // Tell the admins someone arrived — BRANCH-SCOPED like every other fan-out
    // in this file ("notified = can see it"): the invite's team branch, else a
    // manager invite's own branch, else org-wide. The new member may themselves
    // now be a manager — exclude them from their own arrival announcement.
    const admins = await this.resolveOrgManagers(
      inv.org_user_id, inv.team_department ?? inv.invited_department,
    ).catch(() => [] as string[]);
    await Promise.allSettled(
      [...new Set(admins)].filter(a => a !== userId)
        .map(a => this.push.enterpriseInviteAccepted(a, inv.org_user_id)),
    );
    return {ok: true};
  }

  /**
   * Seed the approved member into every channel their membership entitles them
   * to.
   *
   * Mirrors seedChannelMembers' visibility rule (restricted / incident are
   * managers-only) rather than re-deriving it, and each row's posting role comes
   * from that channel's own post_mode, so an `open` channel makes them a poster
   * exactly as it would for any other member.
   *
   * SCOPE (vs2 item 2, P2-d). `opts.scopeIds` restricts the seed to a resolved
   * PATH — the chosen team, its ancestors, its subtree and the broadcasts those
   * cover. Absent means org-wide, which is still correct for an invite that
   * named no team.
   *
   * ⚠️ THE OLD DOCSTRING HERE SAID THE OPPOSITE, and it was right at the time:
   * it recorded that a `teamChannelId` parameter had been added, never read,
   * and removed, and told the next reader not to "restore" one. That warning is
   * now obsolete and is deleted rather than left standing, because leaving it
   * would have the next reviewer revert this feature as a regression. What it
   * was actually protecting against remains true and is preserved below: the
   * chosen team gets NO exemption from the visibility rule. A scope is a
   * narrowing, never a licence to force an employee into a managers-only
   * channel — so `seedsManagersOnly` is still applied to every candidate,
   * including the team itself.
   */
  /**
   * Members whose channel seed did not complete — the reader for
   * `seed_pending_at`.
   *
   * BRANCH-SCOPED like every other fan-out in this file ("notified = can see
   * it"): a manager scoped to one branch must not be handed the names of people
   * who joined another. The predicate mirrors decideJoinRequest's claim filter,
   * archive-awareness included, so what a manager can SEE here is exactly what
   * they could have decided.
   */
  async listSeedPending(orgUserId: string, department: string | null): Promise<Array<{
    applicant_user_id: string; display_name: string | null;
    team_name: string | null; seed_pending_at: Date;
  }>> {
    return this.db.q(
      `SELECT r.applicant_user_id, u.display_name,
              CASE WHEN c.archived_at IS NULL THEN c.name END AS team_name,
              r.seed_pending_at
         FROM public.enterprise_join_requests r
         LEFT JOIN public.users u ON u.id = r.applicant_user_id
         LEFT JOIN public.department_channels c ON c.id = r.team_channel_id
        WHERE r.org_user_id = $1
          AND r.seed_pending_at IS NOT NULL
          AND ($2::text IS NULL OR COALESCE((
                SELECT CASE WHEN c2.archived_at IS NULL THEN c2.department END
                  FROM public.department_channels c2
                 WHERE c2.id = r.team_channel_id), $2) = $2)
        ORDER BY r.seed_pending_at ASC
        LIMIT 200`,
      [orgUserId, department ?? null],
    );
  }

  /**
   * RE-RUN the channel seed for a member whose first attempt did not complete.
   *
   * The listing alone was the spec's own stated failure mode — "an unread
   * column is the same silence in a new place" — with one extra step: neither
   * accept lane can be replayed (the invite is consumed, the request is already
   * approved, so both conditional claims match nothing), so once the flag was
   * set NOTHING in the codebase could ever clear it. The manager got a list of
   * names and no verb.
   *
   * Idempotent by construction: addMember absorbs rows that already exist, so
   * this is safe to press repeatedly and safe to press on a member who is
   * actually fine.
   */
  async reseedMember(
    orgUserId: string, managerDepartment: string | null, memberUserId: string,
  ): Promise<{ok: true}> {
    // Branch-scoped, via the SAME predicate as the listing — a manager must not
    // repair someone they cannot see.
    const row = await this.db.qOne<{
      team_channel_id: string | null; team_parent_id: string | null; member_role: string | null;
    }>(
      `SELECT r.team_channel_id,
              (SELECT l.team_parent_id FROM public.enterprise_referral_links l
                WHERE l.id = r.link_id) AS team_parent_id,
              (SELECT m.member_role FROM public.org_members m
                WHERE m.org_user_id = r.org_user_id
                  AND m.member_user_id = r.applicant_user_id) AS member_role
         FROM public.enterprise_join_requests r
        WHERE r.org_user_id = $1 AND r.applicant_user_id = $3
          AND r.status = 'approved' AND r.seed_pending_at IS NOT NULL
          AND ($2::text IS NULL OR COALESCE((
                SELECT CASE WHEN c.archived_at IS NULL THEN c.department END
                  FROM public.department_channels c
                 WHERE c.id = r.team_channel_id), $2) = $2)`,
      [orgUserId, managerDepartment ?? null, memberUserId],
    );
    if (!row) throw new NotFoundException('seed_pending_not_found');

    const asManager = row.member_role === 'manager';
    const all = await this.db.q<SeedCandidate & QueryResultRow>(
      `SELECT id, parent_id, access, channel_type, is_broadcast,
              (archived_at IS NOT NULL) AS archived
         FROM public.department_channels WHERE org_id = $1`,
      [orgUserId],
    );
    const scope = resolveSeedScope(all, row.team_channel_id, row.team_parent_id, asManager);
    if (scope.kind === 'dead') {
      // Still nothing to grant. Say so rather than clearing the flag on a
      // repair that repaired nothing.
      throw new ConflictException('team_channel_unavailable_reinvite');
    }
    await this.seedApprovedMemberChannels(orgUserId, memberUserId, undefined, {
      asManager, ...(scope.kind === 'scoped' ? {scopeIds: scope.ids} : {}),
    });
    return {ok: true};
  }

  /**
   * Resolve the seed scope INSIDE a transaction, on either side of the claim.
   *
   * The ordering is the whole point. Everything after the commit is
   * contractually best-effort — a throw in the seeder does NOT fail the accept:
   * the caller gets 200, `accepted_at` is set so the link is not re-claimable,
   * and the member sits in the org with zero channels. Resolving here means a
   * dead chain rolls the transaction back instead, which reopens the claim and
   * leaves the invite usable after the admin re-issues a team.
   *
   * Costs no lock-hold time: the claim UPDATE is the transaction's first write,
   * and no advisory lock or FOR UPDATE precedes it.
   */
  private async resolveSeedScopeInTx(
    tx: Tx,
    orgUserId: string, teamChannelId: string | null, teamParentId: string | null,
    asManager = false,
  ): Promise<SeedScope> {
    // BOTH, not just the team. `team_channel_id` is ON DELETE SET NULL, so a
    // hard-deleted team arrives here as null with only the breadcrumb left —
    // and an early return on `!teamChannelId` alone sends exactly that case to
    // the org-wide seed, which is the whole-workspace grant the breadcrumb was
    // added to prevent. The pure function guards this correctly; guarding it
    // there and not here made the column inert on the one lane that has it
    // (written at mint, selected at accept, changing nothing).
    if (!teamChannelId && !teamParentId) {return {kind: 'orgWide'};}
    // Archived rows are SELECTED, not filtered, and carry the flag. They are
    // walk scaffolding only: `survives()` refuses them so they never enter the
    // seeded set, but dropping them from the map entirely makes an archived
    // ancestor UNTRAVERSABLE — the climb hits `undefined`, stops, and reports a
    // dead chain even when a live grandparent is sitting right above it. Two
    // ordinary admin taps (archive the leaf, then its now-childless parent)
    // reach that.
    const rows = await tx.q<SeedCandidate & QueryResultRow>(
      `SELECT id, parent_id, access, channel_type, is_broadcast,
              (archived_at IS NOT NULL) AS archived
         FROM public.department_channels
        WHERE org_id = $1`,
      [orgUserId],
    );
    const scope = resolveSeedScope(rows, teamChannelId, teamParentId, asManager);
    // The fallback SILENTLY narrows a grant from "the team + its subtree" to
    // "an ancestor chain". Without a line here nobody can ever tell it
    // happened — the member simply has fewer channels than the invite implied.
    if (scope.kind === 'scoped' && scope.fellBackTo) {
      this.log.warn(
        `seed scope FELL BACK org=${orgUserId} team=${teamChannelId ?? 'deleted'} `
        + `-> ancestor=${scope.fellBackTo}`);
    }
    return scope;
  }

  private async seedApprovedMemberChannels(
    orgUserId: string, memberUserId: string, decidedBy?: string,
    // asManager (Item E): a MANAGER invite seeds like seedChannelMembers'
    // isManager branch — every channel including managers-only, as an 'admin'
    // poster labelled 'Manager'. The org_members row already says 'manager'
    // (committed before this runs), so addMember's broadcast rank check passes
    // for the same reason it does on workspace creation.
    opts?: {asManager?: boolean; scopeIds?: ReadonlySet<string>},
  ): Promise<void> {
    const asManager = opts?.asManager === true;
    // Candidates only — the DECISION about each one is made by the shared
    // helpers below, never re-derived in this SQL.
    const all = await this.db.q<{
      id: string; access: ChannelAccess; channel_type: ChannelType; post_mode: ChannelPostMode;
    }>(
      `SELECT id, access, channel_type, post_mode
         FROM public.department_channels
        WHERE org_id = $1 AND archived_at IS NULL`,
      [orgUserId],
    );
    // The scope is applied HERE, before the visibility rule, so the two compose
    // in the safe order: narrow to the path, then still refuse anything
    // managers-only inside it.
    const scoped = opts?.scopeIds ? all.filter(c => opts.scopeIds!.has(c.id)) : all;
    // ELIGIBLE candidates, counted AFTER the visibility rule.
    //
    // Counting before it made a legitimate zero-seed look like a failure: a
    // scoped chain routinely contains managers-only rungs BY DESIGN (the walk
    // climbs past them), so an employee whose whole scope is restricted yields
    // candidates > 0, seeded 0, failures 0 — a spurious INCOMPLETE warn and a
    // flag that stays set on a seed that did exactly the right thing.
    const channels = scoped.filter(c =>
      asManager || !DepartmentService.seedsManagersOnly(c.access, c.channel_type));
    // "Zero seeded" is the NORMAL, correct outcome for the first employee of a
    // clean organisation — new workspaces seed no channels at all — so it is
    // only worth recording when there were candidates to seed and none landed.
    const candidates = channels.length;
    let seeded = 0;
    let failures = 0;

    for (const c of channels) {
      // VISIBILITY via the shared helper. The referred team gets NO exemption:
      // `createReferralLink` only checked the team's ORG, so a link could point
      // at a restricted or incident channel and an "always seed the team" branch
      // would force an ordinary employee into a managers-only channel — as a
      // poster, since post_mode defaults to 'open'. "Visible does not
      // automatically grant posting rights" (page 10 rule 2) cuts both ways.
      // The ONLY visibility rule. (An earlier version also carried
      // `id = $2 OR NOT is_broadcast OR is_broadcast` in the SQL and a second
      // access check here — the first is TRUE for every row and the second is
      // unreachable once `restricted` is excluded above. Both were shaped like
      // filters and filtered nothing, which is exactly what gets read as a rule
      // later.)
      if (!asManager && DepartmentService.seedsManagersOnly(c.access, c.channel_type)) {continue;}
      try {
        // MUST go through addMember, never a raw INSERT.
        //
        // addMember writes the row AND calls enqueueIntent — the only writer of
        // channel_membership_intents, which the admin device drains to broadcast
        // the rekey. A raw insert gave the member roster rows with NO group
        // master key: listChannels returned the channels, the UI listed them,
        // and every message in them was undecryptable. That is the exact
        // "no group master key" failure this repo has shipped before, and
        // removeMember's own comment calls this the security-critical seam.
        await this.department.addMember(
          orgUserId, c.id, memberUserId,
          asManager ? 'admin' : DepartmentService.memberRoleFor(c.post_mode),
          asManager ? 'Manager' : undefined, decidedBy,
        );
        seeded++;
      } catch (e: unknown) {
        // Idempotent and self-healing: the membership row is already committed,
        // so a channel that fails here can be re-seeded later without the
        // approval being lost. Never fail an approval over it.
        failures++;
        this.log.warn(`approved-member channel seed failed ch=${c.id}: ${(e as Error)?.message}`);
      }
    }

    // CLEAR the in-tx marker only on a genuinely complete seed.
    //
    // This loop swallows every per-channel failure and returns normally, so a
    // naive "clear at the end" would clear the flag after 4 of 5 channels
    // failed — precisely the partial state the marker exists to record.
    // Success = no per-channel failures AND, when there were candidates, at
    // least one row actually seeded.
    // `candidates === 0` clears the flag because a clean organisation genuinely
    // has nothing to seed — but ONLY when the seed was org-wide. With a scope,
    // zero eligible candidates can also mean the scope's channels were archived
    // between the commit and this post-commit run, which is precisely the state
    // the flag exists to record.
    const legitimatelyEmpty = candidates === 0 && !opts?.scopeIds;
    if (failures === 0 && (legitimatelyEmpty || seeded > 0)) {
      await this.db.q(
        `UPDATE public.enterprise_join_requests
            SET seed_pending_at = NULL
          WHERE org_user_id = $1 AND applicant_user_id = $2 AND status = 'approved'`,
        [orgUserId, memberUserId],
      ).catch(e => this.log.warn(`seed-pending clear failed: ${(e as Error)?.message}`));
    } else {
      this.log.warn(
        `approved-member seed INCOMPLETE org=${orgUserId} member=${memberUserId} `
        + `candidates=${candidates} seeded=${seeded} failures=${failures}`);
    }
  }

  /** Unambiguous alphabet — no O/0/I/1, so a code read off a printed induction
   *  sheet cannot be mistyped into a different valid code.
   *
   *  randomInt, not Math.random: this code is a CAPABILITY — it is the sole
   *  thing needed to read another Enterprise's name and team, and to inject a
   *  row into its admin inbox. V8's Math.random state is recoverable from
   *  observed output, and every other token mint in auth-service uses
   *  node:crypto. */
  private mintCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += alphabet[randomInt(alphabet.length)];
    }
    return out;
  }
}
