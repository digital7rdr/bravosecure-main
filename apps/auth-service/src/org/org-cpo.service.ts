import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {DatabaseService, type Tx} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {DepartmentService} from '../department/department.service';
import {AuthService} from '../auth/auth.service';
import {OrgAuditService} from './org-audit.service';
import {resolveAccountKind} from '../auth/account-kind';
import type {CreateManagedCpoDto, OrgMemberRole, SettableMemberRole} from './dto/org.dto';
import type {ChannelPostMode} from '../department/dto/channel.dto';

// Seed sets mirrored from AgentService.create() so a managed CPO lands in the
// SAME ops review console as a self-registered one. Kept in sync deliberately;
// if AgentService's seed changes, change here too.
const KYC_KINDS = ['gov_id', 'proof_address', 'sia_licence', 'police'] as const;
const REVIEW_STEPS = ['submit', 'docs', 'kyc', 'ops', 'partner'] as const;
const DEPLOYMENT_CHECKS = ['dress', 'vehicle', 'equip', 'briefing'] as const;
const DOC_SEED: {slot: string; required: boolean; title: string}[] = [
  {slot: 'sia',       required: true,  title: 'Security License / CPO Profile'},
  {slot: 'passport',  required: true,  title: 'Passport / National ID'},
  {slot: 'insurance', required: true,  title: 'Professional Indemnity Insurance'},
  {slot: 'dbs',       required: true,  title: 'Police Clearance / DBS Enhanced'},
  {slot: 'firstaid',  required: false, title: 'First Aid Certificate'},
  {slot: 'cv',        required: false, title: 'Professional CV / Résumé'},
];

export interface RosterMember {
  member_user_id: string;
  display_name: string | null;
  email: string | null;
  call_sign: string | null;
  // 'employee' (M1A rule 16) rides alongside the provider roles; the
  // promote/demote DTO deliberately stays cpo|manager only.
  member_role: OrgMemberRole | 'employee';
  status: string;
  agent_status: string | null;
  missions_completed: number;
  created_at: Date;
  // LM-A4/F11 — authoritative availability signals for the assign sheet + roster.
  on_duty: boolean;
  on_mission: boolean;
  armed_authorized: boolean;
  avatar_url: string | null;
  // Suspension window. suspended_until NULL while suspended = indefinite.
  suspended_from: Date | null;
  suspended_until: Date | null;
  suspend_reason: string | null;
}

/** Longest suspension we accept; beyond this the member should be removed. */
const MAX_SUSPEND_DAYS = 365;

export interface SuspensionWindow {
  from?: string | null;
  until?: string | null;
  reason?: string | null;
}

@Injectable()
export class OrgCpoService {
  private readonly log = new Logger(OrgCpoService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
    private readonly department: DepartmentService,
    private readonly auth: AuthService,
    private readonly audit: OrgAuditService,
  ) {}

  // Add a member to (or remove from) every channel the org owns. Enqueues a
  // rekey intent per channel via DepartmentService — the org account is the
  // channel admin, so it is authorized. Best-effort: chat sync must not break
  // roster mutations.
  private async syncMemberToOrgChannels(
    // Phase 2 — the caller states WHETHER THIS PERSON IS A MANAGER, never a
    // channel role. A role literal here was applied identically to every
    // channel, which is how `open` channels ended up muting anyone who joined
    // the org after the channel was created.
    orgUserId: string, memberUserId: string, action: 'add' | 'remove', asManager?: boolean,
    // The human the member.channel_* audit rows name (I-a M1); the org
    // identity stays the AUTHORIZATION actor.
    auditActor?: string,
  ): Promise<void> {
    // For an add, resolve the member's org role when the caller didn't pass it
    // (e.g. reinstatement) so a manager rejoins EVERY channel while a CPO is
    // confined to OPEN (standard/read_only) channels — a normal CPO must never
    // be auto-seeded into a restricted/incident managers-only channel (Step 18).
    let isManager = asManager === true;
    let memberRole: string | undefined;
    if (action === 'add') {
      const m = await this.db.qOne<{member_role: string}>(
        `SELECT member_role FROM org_members WHERE org_user_id = $1 AND member_user_id = $2`,
        [orgUserId, memberUserId],
      );
      memberRole = m?.member_role;
      if (asManager === undefined) {
        isManager = memberRole === 'manager';
      }
    }
    const cpoAdd = action === 'add' && !isManager;

    const channels = await this.db.q<{id: string; post_mode: ChannelPostMode}>(
      cpoAdd
        // Mirror department.service seedChannelMembers' managers-only rule
        // (access='restricted' OR channel_type='incident') so a normal CPO is
        // never auto-joined into a managers-only channel — incl. an incident
        // channel left at the default 'standard' access.
        ? `SELECT id, post_mode FROM public.department_channels
             WHERE org_id = $1 AND archived_at IS NULL
               AND access IN ('standard', 'read_only')
               AND channel_type <> 'incident'`
        : `SELECT id, post_mode FROM public.department_channels
             WHERE org_id = $1 AND archived_at IS NULL`,
      [orgUserId],
    );
    for (const ch of channels) {
      try {
        if (action === 'add') {
          // Scope v2 Phase 2 — resolve the role PER CHANNEL from that channel's
          // post_mode. A single role reused across every channel meant anyone
          // joining the org after a channel was created was added as 'viewer'
          // even to `open` channels: `open` worked only for members who already
          // existed at creation time. Managers stay 'admin' everywhere.
          const perChannelRole = isManager
            ? 'admin'
            : DepartmentService.memberRoleFor(ch.post_mode ?? 'read_only');
          // A7.3 — only the tenant-independent 'Manager' is persisted. Stamping
          // 'Employee'/'CPO' here re-created the very defect Phase 0 removed:
          // role_label is read in preference to the live noun, so the stored
          // word wins and an Enterprise roster reads "CPO".
          // 'Manager' only when they are an ORG manager — not merely when the
          // channel's post_mode happens to grant them 'admin' (an `open`
          // channel makes ordinary members posters, and they are not managers).
          const label = isManager ? 'Manager' : undefined;
          await this.department.addMember(orgUserId, ch.id, memberUserId, perChannelRole, label, auditActor);
        } else {
          await this.department.removeMember(orgUserId, ch.id, memberUserId, auditActor);
        }
      } catch (e) {
        this.log.warn(`channel ${action} failed for ${memberUserId} on ${ch.id}: ${(e as Error).message}`);
      }
    }
  }

  // ─── M1A rule 16 — enroll an EXISTING user as an org EMPLOYEE ────────
  // The messenger-workspace membership (dept channels / attendance / incident
  // reporting) for Enterprise individuals and provider back-office staff.
  // STRICTLY additive to the provider CPO machinery: no sub-account is
  // minted, deriveAccountKind ignores 'employee' (the member keeps their own
  // app shell), and every mission/crew query filters member_role='cpo', so
  // an employee can never be deployed. Providers' CPO flows are untouched.
  async addEmployee(orgUserId: string, emailOrPhone: string, actorId?: string): Promise<RosterMember> {
    const needle = emailOrPhone.trim();
    const target = await this.db.qOne<{id: string; display_name: string | null; email: string | null}>(
      `SELECT id, display_name, email FROM public.users
        WHERE (LOWER(email) = LOWER($1) OR phone_e164 = $1) AND deleted_at IS NULL`,
      [needle],
    );
    if (!target) throw new NotFoundException('user_not_found');
    if (target.id === orgUserId) throw new BadRequestException('cannot_enroll_yourself');

    // An employee must be a PLAIN INDIVIDUAL. A service-provider agent (its own
    // company / managed CPO / agency manager) already lives in a provider org
    // with its own app shell and roster — enrolling it as an employee would
    // collide two org identities. resolveAccountKind is the same discriminator
    // §35A routes on, so this rejects exactly the accounts that aren't clients.
    const {account_kind} = await resolveAccountKind(this.db, target.id);
    if (account_kind !== 'individual') {
      throw new BadRequestException('provider_account_cannot_be_employee');
    }

    const existing = await this.db.qOne<{member_role: string; status: string}>(
      `SELECT member_role, status FROM org_members
        WHERE org_user_id = $1 AND member_user_id = $2`,
      [orgUserId, target.id],
    );
    if (existing?.status === 'active') {
      throw new BadRequestException('already_a_member');
    }
    if (existing) {
      // Re-enroll a removed/suspended row — as an employee ONLY when it was
      // one; a provider's suspended CPO must be reinstated via the roster
      // (status endpoint), not silently re-typed by the employee flow.
      if (existing.member_role !== 'employee') {
        throw new BadRequestException('member_exists_use_roster_status');
      }
      await this.db.q(
        `UPDATE org_members SET status = 'active'
          WHERE org_user_id = $1 AND member_user_id = $2`,
        [orgUserId, target.id],
      );
    } else {
      await this.db.q(
        `INSERT INTO org_members (org_user_id, member_user_id, member_role, status, invited_by)
         VALUES ($1, $2, 'employee', 'active', $3)`,
        [orgUserId, target.id, actorId ?? orgUserId],
      );
    }

    await this.audit.log(orgUserId, actorId ?? orgUserId, 'member.add', {
      targetKind: 'user', targetId: target.id,
      metadata: {member_role: 'employee', via: 'employee_enroll'},
    }).catch(() => undefined);

    // Seed the new employee into the org's OPEN auto-membership channels the
    // same way managed CPOs are (viewer role; never restricted/incident
    // channels). Best-effort; channel rekey is eventually consistent.
    await this.syncMemberToOrgChannels(orgUserId, target.id, 'add', false, actorId).catch(e =>
      this.log.warn(`employee channel seed failed for ${target.id}: ${(e as Error).message}`),
    );

    const roster = await this.listRoster(orgUserId);
    const row = roster.find(r => r.member_user_id === target.id);
    if (!row) throw new NotFoundException('member_not_found_after_enroll');
    return row;
  }

  // ─── Create a managed CPO sub-account (one transaction) ──────────────
  // Inserts: users (login) + agents (type='cpo', managed_by_org_id=org,
  // status='DOCS_PENDING') + the agent seed rows + org_members. The CPO is a
  // real user that logs in via the normal auth flow; authorization as "belongs
  // to org X" is derived from org_members, never from the token.
  async createManagedCpo(orgUserId: string, dto: CreateManagedCpoDto, actorId?: string): Promise<RosterMember> {
    const existing = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users
        WHERE (email = $1 OR phone_e164 = $2) AND deleted_at IS NULL`,
      [dto.email, dto.phone_e164],
    );
    if (existing) {
      throw new ConflictException('user_already_exists');
    }

    const pwHash = await this.password.hash(dto.temp_password);
    const role = dto.member_role ?? 'cpo';

    let result;
    try {
      result = await this.runCreateManagedCpoTxn(orgUserId, dto, pwHash, role);
    } catch (e) {
      // Step 23 — the soft SELECT above is a courtesy check, not a lock: two agencies
      // racing the same email both pass it, then collide on users.email (citext UNIQUE)
      // or org_members_one_active_agency. Catch the 23505 and surface the same clean
      // 409 instead of leaking a raw constraint error / a half-applied state.
      if ((e as {code?: string}).code === '23505') {
        throw new ConflictException('user_already_exists');
      }
      throw e;
    }

    // RS-11 — first member.* action in org_audit_log: who added whom, with what
    // role. Best-effort: the roster insert already committed.
    await this.audit.log(orgUserId, actorId ?? orgUserId, 'member.add', {
      targetKind: 'user', targetId: result.member_user_id,
      metadata: {member_role: role},
    }).catch(() => {});

    // Post-commit: add the new CPO to the org's existing chat channels (if any
    // have been seeded). The admin device will rekey-on-add via the intent.
    await this.syncMemberToOrgChannels(
      orgUserId, result.member_user_id, 'add', role === 'manager', actorId,
    );
    return result;
  }

  /**
   * Issue 34 — everything a managed agent needs to exist and be dispatchable,
   * shared by createCpo and by invite-code redemption.
   *
   * Extracted rather than duplicated ON PURPOSE. Missing any one of these
   * leaves a broken officer, and the agent_profiles coverage inherit is the
   * subtle one: mirrorAgentToPool REFUSES to mirror an agent with no coverage
   * country, so an officer seeded without it is permanently invisible to the
   * dispatch picker with no visible error anywhere.
   */
  /**
   * Issue 34 — an invited officer joins a provider's roster with a code.
   *
   * Called as the JOINING user (their own JWT), not as the org. The provider
   * still controls membership because it is the only party that can mint a code;
   * this just moves the typing to the officer.
   *
   * The claim is a CONDITIONAL UPDATE, so two people racing one code cannot both
   * join — the loser simply finds no open row and gets the same clear error as a
   * typo. Everything after the claim runs in the same transaction, so a failure
   * anywhere rolls the code back to unredeemed rather than burning it.
   */
  async redeemInviteCode(
    userId: string, rawCode: string,
  ): Promise<{org_user_id: string; member_role: string}> {
    const code = (rawCode ?? '').trim().toUpperCase();
    if (!code) throw new BadRequestException('invite_code_required');

    const existing = await this.db.qOne<{org_user_id: string}>(
      // vs2 item 4 — ROLE-FILTERED, the fifth instance of this class.
      // Unfiltered, an office employee of a company workspace was told "you
      // are already on a provider roster" when redeeming a CPO invite — the
      // consultant case this item exists for, refused at the one door that
      // was not narrowed. Only an existing CPO membership conflicts.
      `SELECT org_user_id FROM org_members
        WHERE member_user_id = $1 AND status <> 'removed' AND member_role = 'cpo'`,
      [userId],
    );
    if (existing) {
      throw new BadRequestException({
        code: 'already_on_a_roster',
        message: 'You are already on a provider roster. Leave it before joining another.',
      });
    }

    return this.db.withTransaction(async tx => {
      // Single-use claim. A code that is unknown, revoked, expired or already
      // taken matches nothing here — all four are the same answer to the user.
      const claimed = await tx.qOne<{
        id: string; org_user_id: string; member_role: string; call_sign: string | null;
      }>(
        `UPDATE provider_invite_codes
            SET redeemed_by = $2, redeemed_at = NOW()
          WHERE code = $1
            AND redeemed_at IS NULL AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > NOW())
          RETURNING id, org_user_id, member_role, call_sign`,
        [code, userId],
      );
      if (!claimed) {
        throw new BadRequestException({
          code: 'invite_code_invalid',
          message: 'That invitation code is not valid, has expired, or has already been used.',
        });
      }

      const me = await tx.qOne<{display_name: string | null}>(
        `SELECT display_name FROM public.users WHERE id = $1`, [userId],
      );
      const role = claimed.member_role === 'manager' ? 'manager' : 'cpo';
      await this.seedManagedAgent(
        tx, userId, claimed.org_user_id, me?.display_name ?? 'Agent',
        claimed.call_sign, role, 'invite_code_redeemed',
      );
      return {org_user_id: claimed.org_user_id, member_role: role};
    });
  }

  private async seedManagedAgent(
    tx: Tx,
    agentUserId: string,
    orgUserId: string,
    displayName: string,
    callSign: string | null,
    role: 'cpo' | 'manager',
    reason: string,
  ): Promise<void> {
    // agents row — owned by the org, skips the self-serve profile wizard
    // (the org supplies identity), starts at DOCS_PENDING for ops review.
    await tx.q(
      `INSERT INTO agents (user_id, type, status, display_name, call_sign, managed_by_org_id)
       VALUES ($1, 'cpo', 'DOCS_PENDING', $2, $3, $4)`,
      [agentUserId, displayName, callSign, orgUserId],
    );
    // Inherit the ORG's coverage (countries + services). A managed CPO never
    // walks the coverage wizard, and mirrorAgentToPool refuses to mirror an
    // agent with no coverage country — without this they'd stay invisible to
    // the dispatch picker forever.
    await tx.q(
      `INSERT INTO agent_profiles (user_id, coverage)
       VALUES ($1, COALESCE(
         (SELECT op.coverage FROM agent_profiles op WHERE op.user_id = $2),
         '{"countries": [], "services": []}'::jsonb
       ))
       ON CONFLICT DO NOTHING`,
      [agentUserId, orgUserId],
    );

    for (const kind of KYC_KINDS) {
      await tx.q(
        `INSERT INTO agent_kyc_checks (user_id, kind, state)
         VALUES ($1, $2, 'queued') ON CONFLICT DO NOTHING`,
        [agentUserId, kind],
      );
    }
    for (const d of DOC_SEED) {
      await tx.q(
        `INSERT INTO agent_documents (user_id, slot, required, title, state)
         VALUES ($1, $2, $3, $4, 'upload') ON CONFLICT (user_id, slot) DO NOTHING`,
        [agentUserId, d.slot, d.required, d.title],
      );
    }
    for (const step of REVIEW_STEPS) {
      await tx.q(
        `INSERT INTO agent_review_pipeline (user_id, step, state)
         VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING`,
        [agentUserId, step],
      );
    }
    for (const key of DEPLOYMENT_CHECKS) {
      await tx.q(
        `INSERT INTO agent_deployment_checks (user_id, check_key, state)
         VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING`,
        [agentUserId, key],
      );
    }

    await tx.q(
      `INSERT INTO org_members
         (org_user_id, member_user_id, member_role, call_sign, status, invited_by)
       VALUES ($1, $2, $3, $4, 'active', $1)`,
      [orgUserId, agentUserId, role, callSign],
    );

    await tx.q(
      `INSERT INTO agent_audit (user_id, from_status, to_status, actor_id, actor_role, metadata)
       VALUES ($1, NULL, 'DOCS_PENDING', $2, 'OPS', $3::jsonb)`,
      [agentUserId, orgUserId, JSON.stringify({reason: reason, org: orgUserId})],
    );
  }

  private async runCreateManagedCpoTxn(
    orgUserId: string, dto: CreateManagedCpoDto, pwHash: string, role: 'cpo' | 'manager',
  ): Promise<RosterMember> {
    return this.db.withTransaction(async (tx) => {
      // Why: the INSERT deliberately omits password_set_at — leaving it NULL
      // marks the managed CPO as still on the agency-issued temp password
      // (must_set_password=true) until they complete POST /auth/me/password.
      const inserted = await tx.qOne<{id: string}>(
        `INSERT INTO public.users
           (id, email, phone_e164, display_name, role, subscription_tier,
            password_hash, kyc_status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'agent', 'lite', $4, 'pending')
         RETURNING id`,
        [dto.email, dto.phone_e164, dto.display_name, pwHash],
      );
      if (!inserted) throw new BadRequestException('failed_to_create_user');
      const cpoUserId = inserted.id;

      await this.seedManagedAgent(
        tx, cpoUserId, orgUserId, dto.display_name, dto.call_sign ?? null, role,
        'managed_cpo_created',
      );

      return {
        member_user_id: cpoUserId,
        display_name: dto.display_name,
        email: dto.email,
        call_sign: dto.call_sign ?? null,
        member_role: role,
        status: 'active',
        agent_status: 'DOCS_PENDING',
        missions_completed: 0,
        created_at: new Date(),
        // A brand-new member has no photo and has never been suspended.
        avatar_url: null,
        suspended_from: null,
        suspended_until: null,
        suspend_reason: null,
        // LM-A4/F11 — a freshly-minted account is off-duty, unassigned, unarmed.
        on_duty: false,
        on_mission: false,
        armed_authorized: false,
      };
    });
  }

  // ─── Roster read ────────────────────────────────────────────────────
  // LM-A4/F11 — the assign sheet previously guessed availability from the org's
  // OWN active missions only, so a guard who was off-duty, on ANOTHER org's
  // mission, or without an armed authorization showed as pickable and only the
  // server 409 revealed the truth. Surface the authoritative signals per row:
  // on_duty (agents), active_mission (any org, via the active-unique semantics),
  // armed_authorized (valid regional authorization).
  async listRoster(orgUserId: string): Promise<RosterMember[]> {
    // A lapsed timed suspension must not survive a roster read — reinstate it
    // (channels included) before we report status to the client.
    await this.expireLapsedSuspensions(orgUserId);
    return this.db.q<RosterMember>(
      `SELECT om.member_user_id, u.display_name, u.email, om.call_sign,
              om.member_role, om.status, om.department, a.status AS agent_status,
              COALESCE(mc_cnt.completed, 0)::int AS missions_completed,
              om.created_at, u.avatar_url,
              om.suspended_from, om.suspended_until, om.suspend_reason,
              COALESCE(a.on_duty, FALSE) AS on_duty,
              EXISTS (
                SELECT 1 FROM mission_crew mc2
                  JOIN missions m2 ON m2.id = mc2.mission_id
                 WHERE mc2.agent_id = om.member_user_id AND mc2.status <> 'off'
                   AND m2.status NOT IN ('COMPLETED', 'ABORTED')
              ) AS on_mission,
              EXISTS (
                SELECT 1 FROM armed_authorizations aa
                 WHERE aa.cpo_user_id = om.member_user_id
                   AND aa.authorized AND (aa.expires_at IS NULL OR aa.expires_at > NOW())
              ) AS armed_authorized
         FROM org_members om
         JOIN public.users u ON u.id = om.member_user_id
         LEFT JOIN agents a ON a.user_id = om.member_user_id
         LEFT JOIN (
           SELECT mc.agent_id, count(DISTINCT mc.mission_id) AS completed
             FROM mission_crew mc
             JOIN missions m ON m.id = mc.mission_id AND m.status = 'COMPLETED'
             JOIN lite_bookings b ON b.id = m.booking_id
            WHERE b.assigned_provider_user_id = $1
            GROUP BY mc.agent_id
         ) mc_cnt ON mc_cnt.agent_id = om.member_user_id
        WHERE om.org_user_id = $1
        ORDER BY om.created_at DESC`,
      [orgUserId],
    );
  }

  /**
   * MISSION-HISTORY (#3) — a roster CPO's completed/aborted-mission call-log,
   * ORG-SCOPED so a manager only ever sees missions THEIR agency owned. The
   * org_members membership check is the IDOR gate; `b.assigned_provider_user_id = $1`
   * keeps every returned row inside this org. Mirrors AgentService.getMyMissionHistory
   * but adds the tenancy predicate (and omits deduction detail — finance gate).
   */
  async listMemberMissionHistory(orgUserId: string, memberUserId: string, limit = 50): Promise<Array<{
    mission_id: string; booking_id: string; short_code: string; status: string;
    role: string; is_lead: boolean; started_at: string | null; ended_at: string | null;
    route_distance_m: number | null; route_duration_s: number | null;
    pickup_address: string; dropoff_address: string | null; region_label: string | null;
    paid_credits: number | null;
  }>> {
    const ok = await this.db.qOne<{ok: number}>(
      `SELECT 1 AS ok FROM org_members WHERE org_user_id = $1 AND member_user_id = $2`,
      [orgUserId, memberUserId],
    );
    if (!ok) {throw new ForbiddenException('not_your_org_member');}
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const rows = await this.db.q<{
      mission_id: string; booking_id: string; short_code: string; status: string;
      role: string; is_lead: boolean; started_at: string | null; ended_at: string | null;
      route_distance_m: number | null; route_duration_s: number | null;
      pickup_address: string; dropoff_address: string | null; region_label: string | null;
      paid_credits: number | null;
    }>(
      `SELECT m.id AS mission_id, m.booking_id, m.short_code, m.status,
              mc.role, mc.is_lead, m.started_at, m.ended_at,
              m.route_distance_m, m.route_duration_s,
              b.pickup_address, b.dropoff_address, b.region_label,
              mp.paid_credits
         FROM mission_crew mc
         JOIN missions m       ON m.id = mc.mission_id
         JOIN lite_bookings b  ON b.id = m.booking_id
         LEFT JOIN mission_payouts mp
                ON mp.mission_id = m.id AND mp.agent_user_id = mc.agent_id
        WHERE mc.agent_id = $2
          AND b.assigned_provider_user_id = $1
          AND m.status IN ('COMPLETED','ABORTED')
        ORDER BY m.ended_at DESC NULLS LAST, m.started_at DESC
        LIMIT $3`,
      [orgUserId, memberUserId, safeLimit],
    );
    return rows.map(r => ({
      mission_id: r.mission_id, booking_id: r.booking_id, short_code: r.short_code,
      status: r.status, role: r.role, is_lead: r.is_lead,
      started_at: r.started_at, ended_at: r.ended_at,
      route_distance_m: r.route_distance_m, route_duration_s: r.route_duration_s,
      pickup_address: r.pickup_address, dropoff_address: r.dropoff_address,
      region_label: r.region_label,
      paid_credits: r.paid_credits === null ? null : Number(r.paid_credits),
    }));
  }

  /**
   * Everything the agency knows about one roster officer, in a single round-trip
   * so the profile screen does not fan out into five calls. Same IDOR close as
   * listMemberMissionHistory: the org comes from the guard, and the member must
   * belong to it.
   */
  async getMemberProfile(orgUserId: string, memberUserId: string, viewerId?: string) {
    await this.expireLapsedSuspensions(orgUserId);
    // The org owner is the org (org_user_id IS their own id) — they have no
    // org_members row, so the roster-scoped query below always threw
    // 'not_your_org_member' for their own profile. Every other member/manager
    // reachable from OrgHierarchyScreen or a chat sender tap got a real
    // profile; the owner got a dead end. Serve their identity from
    // public.users directly instead.
    if (memberUserId === orgUserId) {
      return this.getOwnerProfile(orgUserId);
    }
    // Issue 39 — the PDF requires data minimisation, permission control AND
    // AUDIT OF ACCESS for this screen: it exposes an officer's contact details,
    // qualifications and duty state. Recorded on the ORG tier (org_audit_log is
    // append-only), never the HQ tier. Written BEFORE the read so an access
    // attempt is logged even if the row lookup then throws — an unauthorised
    // probe is exactly what an access log exists to catch.
    //
    // 🛑 Coarse metadata only. No name, email, phone or capability values —
    // logging the data would defeat the minimisation the same clause demands.
    if (viewerId) {
      await this.audit
        .log(orgUserId, viewerId, 'roster.profile.view', {
          targetKind: 'org_member',
          targetId: memberUserId,
        })
        .catch(e => this.log.warn(`roster view audit failed: ${(e as Error).message}`));
    }
    const row = await this.db.qOne<Record<string, unknown>>(
      `SELECT om.member_user_id, u.display_name, u.email, u.phone_e164, u.avatar_url,
              om.call_sign, om.member_role, om.status, om.created_at,
              om.suspended_from, om.suspended_until, om.suspend_reason,
              sb.display_name AS suspended_by_name,
              a.status AS agent_status,
              a.rating AS agent_rating,
              -- capabilities lives on agent_profiles, NOT agents. As
              -- a.capabilities this threw "column a.capabilities does not
              -- exist" and 500'd the whole member-profile endpoint — both the
              -- departmental-chat sender tap and OrgHierarchyScreen land here.
              ap.capabilities AS agent_capabilities,
              COALESCE(a.on_duty, FALSE) AS on_duty,
              EXISTS (
                SELECT 1 FROM mission_crew mc2
                  JOIN missions m2 ON m2.id = mc2.mission_id
                 WHERE mc2.agent_id = om.member_user_id AND mc2.status <> 'off'
                   AND m2.status NOT IN ('COMPLETED', 'ABORTED')
              ) AS on_mission,
              EXISTS (
                SELECT 1 FROM armed_authorizations aa
                 WHERE aa.cpo_user_id = om.member_user_id
                   AND aa.authorized AND (aa.expires_at IS NULL OR aa.expires_at > NOW())
              ) AS armed_authorized,
              -- Issue 39 — the SOONEST expiry across this officer's live armed
              -- permits. NULL means either no permit or no expiry recorded; the
              -- client must not render NULL as "expired".
              (SELECT min(aa2.expires_at) FROM armed_authorizations aa2
                WHERE aa2.cpo_user_id = om.member_user_id
                  AND aa2.authorized AND aa2.expires_at IS NOT NULL
              ) AS armed_expires_at,
              -- Issue 39 — the compliance pack with validity windows, so the
              -- provider can see a LAPSED certificate instead of a bare
              -- capability tag. permit/file refs are deliberately NOT selected.
              COALESCE((
                SELECT json_agg(json_build_object(
                         'slot', ad.slot, 'title', ad.title, 'state', ad.state,
                         'expires_at', ad.expires_at, 'issuing_body', ad.issuing_body)
                         ORDER BY ad.expires_at NULLS LAST, ad.slot)
                  FROM agent_documents ad WHERE ad.user_id = om.member_user_id
              ), '[]') AS qualifications,
              st.missions_total, st.missions_completed, st.missions_aborted,
              st.missions_led, st.total_distance_m, st.total_duration_s, st.credits_earned
         FROM org_members om
         JOIN public.users u ON u.id = om.member_user_id
         LEFT JOIN public.users sb ON sb.id = om.suspended_by
         LEFT JOIN agents a ON a.user_id = om.member_user_id
         LEFT JOIN agent_profiles ap ON ap.user_id = om.member_user_id
         LEFT JOIN LATERAL (
           SELECT count(*)::int                                              AS missions_total,
                  count(*) FILTER (WHERE m.status = 'COMPLETED')::int        AS missions_completed,
                  count(*) FILTER (WHERE m.status = 'ABORTED')::int          AS missions_aborted,
                  count(*) FILTER (WHERE mc.is_lead)::int                    AS missions_led,
                  COALESCE(sum(m.route_distance_m), 0)::bigint               AS total_distance_m,
                  COALESCE(sum(m.route_duration_s), 0)::bigint               AS total_duration_s,
                  COALESCE(sum(mp.paid_credits), 0)                          AS credits_earned
             FROM mission_crew mc
             JOIN missions m      ON m.id = mc.mission_id
             JOIN lite_bookings b ON b.id = m.booking_id
             LEFT JOIN mission_payouts mp
                    ON mp.mission_id = m.id AND mp.agent_user_id = mc.agent_id
            WHERE mc.agent_id = om.member_user_id
              AND b.assigned_provider_user_id = $1
              AND m.status IN ('COMPLETED','ABORTED')
         ) st ON true
        WHERE om.org_user_id = $1 AND om.member_user_id = $2`,
      [orgUserId, memberUserId],
    );
    if (!row) throw new ForbiddenException('not_your_org_member');

    const n = (v: unknown) => Number(v ?? 0);
    return {
      member_user_id:    row.member_user_id as string,
      display_name:      (row.display_name ?? null) as string | null,
      email:             (row.email ?? null) as string | null,
      phone_e164:        (row.phone_e164 ?? null) as string | null,
      avatar_url:        (row.avatar_url ?? null) as string | null,
      call_sign:         (row.call_sign ?? null) as string | null,
      member_role:       row.member_role as string,
      status:            row.status as string,
      agent_status:      (row.agent_status ?? null) as string | null,
      // Issue 39 — already persisted on `agents`, never surfaced to the
      // provider. rating is NULL until the CPO has been rated at least once.
      rating:            row.agent_rating === null || row.agent_rating === undefined
                           ? null : Number(row.agent_rating),
      capabilities:      Array.isArray(row.agent_capabilities)
                           ? (row.agent_capabilities as string[]) : [],
      armed_authorized:  !!row.armed_authorized,
      // Issue 39 — expiry, so the roster shows a lapsed qualification instead
      // of implying every recorded capability is current.
      armed_expires_at:  (row.armed_expires_at ?? null) as Date | null,
      qualifications:    Array.isArray(row.qualifications)
                           ? (row.qualifications as Array<{
                               slot: string; title: string; state: string;
                               expires_at: string | null; issuing_body: string | null;
                             }>)
                           : [],
      on_duty:           !!row.on_duty,
      on_mission:        !!row.on_mission,
      created_at:        row.created_at as Date,
      suspended_from:    (row.suspended_from ?? null) as Date | null,
      suspended_until:   (row.suspended_until ?? null) as Date | null,
      suspend_reason:    (row.suspend_reason ?? null) as string | null,
      suspended_by_name: (row.suspended_by_name ?? null) as string | null,
      stats: {
        missions_total:     n(row.missions_total),
        missions_completed: n(row.missions_completed),
        missions_aborted:   n(row.missions_aborted),
        missions_led:       n(row.missions_led),
        total_distance_m:   n(row.total_distance_m),
        total_duration_s:   n(row.total_duration_s),
        credits_earned:     n(row.credits_earned),
      },
    };
  }

  /** Owner half of `getMemberProfile` — no org_members/mission_crew row to join against. */
  private async getOwnerProfile(orgUserId: string) {
    const row = await this.db.qOne<Record<string, unknown>>(
      `SELECT id AS member_user_id, display_name, email, phone_e164, avatar_url, created_at
         FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
      [orgUserId],
    );
    if (!row) throw new NotFoundException('org_not_found');
    return {
      member_user_id:    row.member_user_id as string,
      display_name:      (row.display_name ?? null) as string | null,
      email:             (row.email ?? null) as string | null,
      phone_e164:        (row.phone_e164 ?? null) as string | null,
      avatar_url:        (row.avatar_url ?? null) as string | null,
      call_sign:         null as string | null,
      member_role:       'owner',
      status:            'active',
      agent_status:      null as string | null,
      armed_authorized:  false,
      on_duty:           false,
      on_mission:        false,
      created_at:        row.created_at as Date,
      suspended_from:    null as Date | null,
      suspended_until:   null as Date | null,
      suspend_reason:    null as string | null,
      suspended_by_name: null as string | null,
      stats: {
        missions_total: 0, missions_completed: 0, missions_aborted: 0,
        missions_led: 0, total_distance_m: 0, total_duration_s: 0, credits_earned: 0,
      },
    };
  }

  /**
   * Org chart. org_members has no reports_to column, so the hierarchy is a ROLE
   * TIER (owner → managers → cpos/employees), not a reporting chain. Removed
   * members are excluded; suspended ones are included so the chart tells the
   * truth (the client dims them).
   */
  async getOrgHierarchy(orgUserId: string) {
    await this.expireLapsedSuspensions(orgUserId);
    const owner = await this.db.qOne<{
      user_id: string; display_name: string | null; email: string | null; avatar_url: string | null;
    }>(
      `SELECT id AS user_id, display_name, email, avatar_url
         FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
      [orgUserId],
    );
    if (!owner) throw new NotFoundException('org_not_found');

    const rows = await this.db.q<{
      user_id: string; display_name: string | null; email: string | null;
      avatar_url: string | null; member_role: string; status: string; call_sign: string | null;
      on_duty: boolean | null;
    }>(
      // on_duty (B-203): the org-chart dot reflects the member's DUTY toggle, not
      // socket connectivity — "who is available to work right now". Only an
      // active CPO/manager agent row carries it; NULL (employee, no agent) → off.
      `SELECT om.member_user_id AS user_id, u.display_name, u.email, u.avatar_url,
              om.member_role, om.status, om.call_sign,
              (a.on_duty IS TRUE AND om.status = 'active') AS on_duty
         FROM org_members om
         JOIN public.users u ON u.id = om.member_user_id
         LEFT JOIN agents a ON a.user_id = om.member_user_id
        WHERE om.org_user_id = $1 AND om.status <> 'removed'
        ORDER BY u.display_name NULLS LAST`,
      [orgUserId],
    );

    const ownerDuty = await this.db.qOne<{on_duty: boolean | null}>(
      `SELECT on_duty FROM agents WHERE user_id = $1`,
      [orgUserId],
    );

    const position = (role: string) =>
      role === 'manager' ? 'Manager' : role === 'employee' ? 'Employee' : 'CPO';
    const node = (r: (typeof rows)[number]) => ({
      user_id: r.user_id, display_name: r.display_name, email: r.email,
      avatar_url: r.avatar_url, position: position(r.member_role),
      status: r.status, call_sign: r.call_sign, on_duty: r.on_duty === true,
    });

    return {
      owner: {
        user_id: owner.user_id, display_name: owner.display_name, email: owner.email,
        avatar_url: owner.avatar_url, position: 'Owner', status: 'active', call_sign: null,
        on_duty: ownerDuty?.on_duty === true,
      },
      managers: rows.filter(r => r.member_role === 'manager').map(node),
      members:  rows.filter(r => r.member_role !== 'manager').map(node),
    };
  }

  /**
   * Every module key an owner can grant/revoke for a manager's dashboard.
   *
   * MUST stay in sync with the dashboard's own row keys: the founder rule is
   * "the owner decides, and a manager granted nothing has nothing", so any row
   * key missing from this list would be permanently unreachable — the manager
   * can't see it and the owner has no switch to turn it on. That is exactly
   * what msg/intel/region were before they were added here (they bypassed the
   * grant filter as hardcoded "always visible" rows instead).
   */
  static readonly MANAGER_MODULES = [
    'jobs', 'portal', 'compliance', 'roster', 'orgChart', 'dept', 'earn',
    'msg', 'intel', 'region',
  ] as const;

  /**
   * Owner-only — every manager in the org with their currently granted
   * dashboard modules, for the "Manager Permissions" screen. permitted_modules
   * is NULL until the owner grants the manager's FIRST module; that reads as
   * the empty set here and on the manager's own dashboard, which is the point
   * — an unconfigured manager has no modules.
   */
  async listManagers(orgUserId: string): Promise<Array<{
    user_id: string; display_name: string | null; email: string | null;
    avatar_url: string | null; call_sign: string | null; status: string;
    permitted_modules: string[];
  }>> {
    const rows = await this.db.q<{
      user_id: string; display_name: string | null; email: string | null;
      avatar_url: string | null; call_sign: string | null; status: string;
      permitted_modules: string[] | null;
    }>(
      `SELECT om.member_user_id AS user_id, u.display_name, u.email, u.avatar_url,
              om.call_sign, om.status, om.permitted_modules
         FROM org_members om
         JOIN public.users u ON u.id = om.member_user_id
        WHERE om.org_user_id = $1 AND om.member_role = 'manager' AND om.status <> 'removed'
        ORDER BY u.display_name NULLS LAST`,
      [orgUserId],
    );
    return rows.map(r => ({...r, permitted_modules: r.permitted_modules ?? []}));
  }

  /**
   * Owner-only — replaces the full granted-module set for one manager (D5:
   * only the owner may promote/permission a manager, never a peer manager —
   * enforced by the controller checking the caller IS the org account, not
   * merely OrgManagerGuard-passing). Unknown module keys are rejected so a
   * typo can't silently grant nothing while looking like success.
   */
  async setManagerPermissions(orgUserId: string, memberUserId: string, modules: string[], actorId: string): Promise<{ok: true; permitted_modules: string[]}> {
    // Mirrors setMemberRole's own owner-only gate exactly (D5 — only the
    // owner may promote/permission a manager, never a peer manager).
    // OrgManagerGuard alone isn't enough here: it also passes for a
    // delegated manager, who must NOT be able to grant themselves or
    // another manager more modules than the owner gave them.
    if (actorId !== orgUserId) {
      throw new ForbiddenException('only_org_owner_can_change_permissions');
    }
    const allowed = new Set<string>(OrgCpoService.MANAGER_MODULES);
    const deduped = [...new Set(modules)];
    for (const m of deduped) {
      if (!allowed.has(m)) throw new BadRequestException(`unknown_module:${m}`);
    }
    const row = await this.db.qOne<{permitted_modules: string[] | null}>(
      `UPDATE org_members SET permitted_modules = $3
        WHERE org_user_id = $1 AND member_user_id = $2 AND member_role = 'manager'
        RETURNING permitted_modules`,
      [orgUserId, memberUserId, deduped],
    );
    if (!row) throw new NotFoundException('manager_not_found');
    return {ok: true, permitted_modules: row.permitted_modules ?? []};
  }

  /**
   * Step 20 — capacity summary for the agency dashboard "X of Y guards free" strip.
   * free = active roster CPOs − CPOs on a non-terminal mission − seats reserved by
   * accepted-but-not-yet-crewed (CONFIRMED, no mission) bookings. Mirrors the
   * has_free_cpo_capacity() SQL fn (Step 6) so the strip and the matchmaker agree.
   */
  async getCapacity(orgUserId: string): Promise<{
    guards_total: number; guards_free: number; guards_on_duty: number; active_missions: number;
    // The ORG's headline KPIs. The dashboard used to read these off
    // `/agents/me`, which is a SELF endpoint — so a promoted manager (whose own
    // `agents` row stays type='cpo') saw their personal crewed-mission count and
    // a null rating instead of the agency's.
    //
    // org_jobs_total is COUNTED from completed missions, not read from the
    // `agents.jobs_total` counter it used to use. That counter is bumped in
    // exactly one place — settleBooking — so it only ever reflects jobs that
    // reached settlement. Founder report "it says 2 jobs, the company completed
    // a lot": production had jobs_total = 2 against 16 completed missions and
    // ZERO mission_payouts rows, i.e. settlement had never run for that org, on
    // BOTH the owner and manager dashboards (same field). Counting the missions
    // is immune to which completion path ran and cannot drift.
    //
    // org_rating still reads `agents.rating`: that roll-up runs on the rating
    // submission path, and production agrees with the source (4 rated bookings,
    // all 5.00 → 5.00).
    org_rating: number | null; org_jobs_total: number;
  }> {
    const row = await this.db.qOne<{total: string; busy: string; reserved: string; on_duty: string; active: string; completed: string}>(
      `SELECT
         (SELECT count(*) FROM org_members om
           WHERE om.org_user_id = $1 AND om.member_role = 'cpo' AND om.status = 'active')::text AS total,
         COALESCE((SELECT count(DISTINCT mc.agent_id)
            FROM mission_crew mc
            JOIN missions m ON m.id = mc.mission_id
            JOIN lite_bookings b ON b.id = m.booking_id
           WHERE b.assigned_provider_user_id = $1 AND m.status NOT IN ('COMPLETED','ABORTED')), 0)::text AS busy,
         COALESCE((SELECT sum(b.cpo_count)
            FROM lite_bookings b
           WHERE b.assigned_provider_user_id = $1 AND b.status = 'CONFIRMED'
             AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.booking_id = b.id)), 0)::text AS reserved,
         COALESCE((SELECT count(*)
            FROM org_members om JOIN agents a ON a.user_id = om.member_user_id
           WHERE om.org_user_id = $1 AND om.member_role = 'cpo' AND om.status = 'active' AND a.on_duty), 0)::text AS on_duty,
         COALESCE((SELECT count(*)
            FROM missions m JOIN lite_bookings b ON b.id = m.booking_id
           WHERE b.assigned_provider_user_id = $1 AND m.status NOT IN ('COMPLETED','ABORTED')), 0)::text AS active,
         COALESCE((SELECT count(*)
            FROM missions m JOIN lite_bookings b ON b.id = m.booking_id
           WHERE b.assigned_provider_user_id = $1 AND m.status = 'COMPLETED'), 0)::text AS completed`,
      [orgUserId],
    );
    const kpi = await this.db.qOne<{rating: string | null}>(
      `SELECT rating FROM agents WHERE user_id = $1`,
      [orgUserId],
    );
    const total = Number(row?.total ?? 0);
    const free = total - Number(row?.busy ?? 0) - Number(row?.reserved ?? 0);
    return {
      guards_total: total,
      guards_free: Math.max(0, free),
      guards_on_duty: Number(row?.on_duty ?? 0),
      active_missions: Number(row?.active ?? 0),
      org_rating: kpi?.rating != null ? Number(kpi.rating) : null,
      org_jobs_total: Number(row?.completed ?? 0),
    };
  }

  // ─── Apply to a job AS THE ORG, naming a deployed CPO ───────────────
  // The org is the applicant + payee (agent_id = applicant_org_id = org);
  // the named CPO is the deployed officer (assigned_cpo_user_id). One
  // application per org per job via the UNIQUE(job_id, agent_id) constraint.
  async applyAsOrg(
    orgUserId: string, jobId: string,
    args: {cpoUserId: string; dressPledge: string},
  ): Promise<{id: string; status: string; assigned_cpo_user_id: string}> {
    const pledge = (args.dressPledge ?? '').trim();
    if (pledge.length < 4) throw new BadRequestException('dress_pledge_required');

    // The named CPO must be an ACTIVE member of THIS org (tenant isolation +
    // can't deploy a suspended/removed officer).
    const member = await this.db.qOne<{call_sign: string | null; status: string}>(
      `SELECT om.call_sign, a.status
         FROM org_members om
         LEFT JOIN agents a ON a.user_id = om.member_user_id
        WHERE om.org_user_id = $1 AND om.member_user_id = $2 AND om.status = 'active'`,
      [orgUserId, args.cpoUserId],
    );
    if (!member) throw new BadRequestException('cpo_not_active_member_of_org');
    if (member.status !== 'ACTIVE' && member.status !== 'APPROVED') {
      throw new BadRequestException('cpo_not_approved_for_deployment');
    }

    const job = await this.db.qOne<{status: string}>(
      `SELECT status FROM jobs WHERE id = $1`, [jobId],
    );
    if (!job) throw new BadRequestException('job_not_found');
    if (job.status !== 'PUBLISHED') throw new BadRequestException('job_not_open');

    const callSign = member.call_sign?.trim() || `ORG-${orgUserId.slice(0, 4).toUpperCase()}`;

    const row = await this.db.qOne<{id: string; status: string; assigned_cpo_user_id: string}>(
      `INSERT INTO job_applications
         (job_id, agent_id, agent_call_sign, status, dress_pledge, dress_pledged_at,
          applicant_org_id, assigned_cpo_user_id)
       VALUES ($1, $2, $3, 'PENDING', $4, NOW(), $2, $5)
       ON CONFLICT (job_id, agent_id) DO UPDATE
         SET dress_pledge         = EXCLUDED.dress_pledge,
             dress_pledged_at     = EXCLUDED.dress_pledged_at,
             assigned_cpo_user_id = EXCLUDED.assigned_cpo_user_id,
             agent_call_sign      = EXCLUDED.agent_call_sign
       RETURNING id, status, assigned_cpo_user_id`,
      [jobId, orgUserId, callSign, pledge, args.cpoUserId],
    );
    if (!row) throw new BadRequestException('apply_failed');
    return row;
  }

  /**
   * Is this member crewed on a mission that has not finished yet?
   *
   * Why extracted: the same predicate is rendered by listRoster (`on_mission`)
   * and now gates suspend/remove. Two hand-copied copies is exactly how this
   * repo's drift bugs start — one call site changes, the other silently rots.
   */
  private async isOnLiveMission(memberUserId: string): Promise<boolean> {
    const row = await this.db.qOne<{on_mission: boolean}>(
      `SELECT EXISTS (
         SELECT 1 FROM mission_crew mc
           JOIN missions m ON m.id = mc.mission_id
          WHERE mc.agent_id = $1 AND mc.status <> 'off'
            AND m.status NOT IN ('COMPLETED', 'ABORTED')
       ) AS on_mission`,
      [memberUserId],
    );
    return !!row?.on_mission;
  }

  /**
   * Reinstate any timed suspension whose window has elapsed.
   *
   * Deliberately NOT a bare status flip: suspension strips the member from every
   * org channel and rotates the group key, so expiry has to run the normal
   * reinstate path to put them back. Lazy (called from reads) rather than a cron
   * — no new infra and no missed-tick window.
   */
  private async expireLapsedSuspensions(orgUserId: string): Promise<void> {
    const due = await this.db.q<{member_user_id: string}>(
      `SELECT member_user_id FROM org_members
        WHERE org_user_id = $1 AND status = 'suspended'
          AND suspended_until IS NOT NULL AND suspended_until <= now()`,
      [orgUserId],
    );
    for (const m of due) {
      try {
        await this.setMemberStatus(orgUserId, m.member_user_id, 'active', orgUserId);
      } catch (e) {
        // One stuck member must not block the rest of the sweep.
        this.log.warn(`suspension expiry failed for ${m.member_user_id}: ${(e as Error).message}`);
      }
    }
  }

  /** Validates the window and returns the columns to persist. */
  private resolveSuspensionWindow(w: SuspensionWindow | undefined): {
    from: Date; until: Date | null; reason: string;
  } {
    const reason = (w?.reason ?? '').trim();
    if (!reason) throw new BadRequestException('suspend_reason_required');
    if (reason.length > 280) throw new BadRequestException('suspend_reason_too_long');

    const from = w?.from ? new Date(w.from) : new Date();
    if (Number.isNaN(from.getTime())) throw new BadRequestException('invalid_suspended_from');

    if (w?.until === undefined || w.until === null) {
      return {from, until: null, reason}; // indefinite — the pre-existing behaviour
    }
    const until = new Date(w.until);
    if (Number.isNaN(until.getTime())) throw new BadRequestException('invalid_suspended_until');
    if (until.getTime() <= from.getTime()) throw new BadRequestException('suspend_window_inverted');
    const days = (until.getTime() - from.getTime()) / 86_400_000;
    if (days > MAX_SUSPEND_DAYS) throw new BadRequestException('suspend_window_too_long');
    return {from, until, reason};
  }

  // ─── Suspend / reinstate / remove a roster member ───────────────────
  async setMemberStatus(
    orgUserId: string, memberUserId: string,
    status: 'active' | 'suspended' | 'removed',
    actorId?: string,
    window?: SuspensionWindow,
  ): Promise<{stranded_room_claims: string[]}> {
    // RANK — a delegated manager may only act on CPOs. `OrgManagerGuard` admits
    // ANY active manager of the org, and `actorId` was previously used only for
    // the audit row and `suspended_by`, never for authorization — so one manager
    // could suspend or remove a PEER manager, which revokes their sessions
    // (:revokeAllUserSessions) and strips them from every org channel. The owner
    // was protected only by accident: they have no `org_members` row, so the
    // UPDATE matched nothing and 400'd. Make both explicit.
    if (actorId && actorId !== orgUserId) {
      if (memberUserId === orgUserId) {
        throw new ForbiddenException('cannot_modify_org_owner');
      }
      const target = await this.db.qOne<{member_role: string}>(
        `SELECT member_role FROM org_members
          WHERE org_user_id = $1 AND member_user_id = $2`,
        [orgUserId, memberUserId],
      );
      // Q7 — the rank rule protects PEER MANAGERS, stated positively. The old
      // `!== 'cpo'` form was written for the agency tenant and silently swept
      // in 'employee' too, so a workspace co-admin could not suspend or remove
      // a plain employee — their whole roster job.
      if (target && target.member_role === 'manager') {
        throw new ForbiddenException('only_org_owner_can_change_manager_status');
      }
    }

    // A CPO standing on a live detail must not be cut off mid-mission: both
    // branches below revoke their sessions and pull them from the ops room,
    // which would strand the client. Complete or abort the mission first.
    if (status === 'suspended' || status === 'removed') {
      if (await this.isOnLiveMission(memberUserId)) {
        throw new ConflictException('member_on_live_mission');
      }
    }

    const win = status === 'suspended' ? this.resolveSuspensionWindow(window) : null;

    const row = await this.db.qOne<{org_user_id: string}>(
      `UPDATE org_members
          SET status          = $3,
              suspended_from  = $4,
              suspended_until = $5,
              suspend_reason  = $6,
              suspended_by    = $7
        WHERE org_user_id = $1 AND member_user_id = $2
        RETURNING org_user_id`,
      [
        orgUserId, memberUserId, status,
        win?.from ?? null, win?.until ?? null, win?.reason ?? null,
        win ? (actorId ?? orgUserId) : null,
      ],
    );
    if (!row) throw new BadRequestException('member_not_found_in_org');

    // RS-11 — roster status changes were previously unaudited.
    await this.audit.log(orgUserId, actorId ?? orgUserId, 'member.status', {
      targetKind: 'user', targetId: memberUserId,
      metadata: {status, from: win?.from ?? null, until: win?.until ?? null, reason: win?.reason ?? null},
    }).catch(() => {});

    // Suspending or removing a CPO must pull them from the org's chat channels
    // AND trigger the remove+rekey (security stop-condition: a removed member
    // keeps the old master key until the rekey broadcasts). Reinstating re-adds.
    if (status === 'suspended' || status === 'removed') {
      // RS-01 — eject the CPO's live sessions the same way DC-04 admin-suspend
      // does (Redis JTI revoke + auth_devices + push revoke), so a suspended/
      // removed CPO can't ride an unexpired access token into the /agents routes or the
      // messenger relay. CpoSessionGuard re-reads the DB per request as the
      // second line of defence; this closes the JTI-only surfaces.
      await this.auth.revokeAllUserSessions(memberUserId);
      await this.syncMemberToOrgChannels(orgUserId, memberUserId, 'remove', undefined, actorId);
      return {
        stranded_room_claims: await this.findStrandedRoomClaims(
          orgUserId, memberUserId, status, actorId ?? orgUserId),
      };
    } else if (status === 'active') {
      await this.syncMemberToOrgChannels(orgUserId, memberUserId, 'add', undefined, actorId);
    }
    return {stranded_room_claims: []};
  }

  /**
   * B-417 — a demoted/suspended/removed member who holds Ops Room crypto
   * claims (B-416) STRANDS those rooms: their device stops draining and every
   * other admin claim-loses and stands down. Claims are deliberately NOT
   * auto-freed (B-416 review: the G-06 repair the manual hatch relies on is
   * conditional, so auto-free converts a bounded liveness gap into a
   * recurring fork window on a routine roster action). This detects and
   * REPORTS instead: audit row + response field, so the owner learns at the
   * moment of the action instead of from a runbook. READ-ONLY on the claims
   * table — its zero-UPDATE/DELETE invariant stands.
   *
   * The intents-EXISTS scope is complete for member-held claims: a member can
   * only win a claim through the drain, whose claim endpoint requires an
   * org-scoped intent row at claim time; teardown deletes room+intents+claim
   * together. Best-effort: a failure here must never fail the roster change.
   */
  private async findStrandedRoomClaims(
    orgUserId: string, memberUserId: string,
    trigger: 'demote' | 'suspended' | 'removed', actorId: string,
  ): Promise<string[]> {
    try {
      const rows = await this.db.q<{conversation_id: string}>(
        `SELECT c.conversation_id
           FROM dispatch_room_crypto_claims c
          WHERE c.claimed_by = $2
            AND EXISTS (SELECT 1 FROM dispatch_room_intents i
                         WHERE i.conversation_id = c.conversation_id
                           AND i.org_user_id = $1)`,
        [orgUserId, memberUserId],
      );
      const ids = rows.map(r => r.conversation_id);
      if (ids.length) {
        await this.audit.log(orgUserId, actorId, 'member.crypto_claims_stranded', {
          targetKind: 'user', targetId: memberUserId,
          metadata: {trigger, rooms: ids},
        }).catch(() => {});
      }
      return ids;
    } catch (e) {
      this.log.error(`stranded-claims check failed for member ${memberUserId}: ${(e as Error).message}`);
      return [];
    }
  }

  // ─── Promote / demote a roster member (RS-10: cpo/employee ⇄ manager) ──
  // Q7 (founder, 2026-08-08) widened this from OWNER-only to owner + any
  // UNSCOPED manager: "there could be multiple admins who manage these
  // things". Two hard lines remain — the OWNER is untouchable (explicit, not
  // just the no-org_members-row accident), and a branch-scoped manager cannot
  // change roles (the same boundary as scoped_manager_cannot_grant_admin on
  // the invite lane). The channel side-effects are the whole point — a raw
  // member_role flip would silently leave the member's channel access (and
  // group keys) wrong:
  //   promote: join every channel (incl. restricted/incident) as channel
  //            admin — key distribution happens via the existing add intents;
  //   demote:  REMOVE from restricted/incident channels (remove+rekey intents
  //            revoke the group key — the security-critical direction) and
  //            downgrade open-channel role to viewer (metadata-only, they
  //            legitimately keep those keys).
  async setMemberRole(
    orgUserId: string, memberUserId: string, newRole: SettableMemberRole, actorId: string,
    managerDepartment?: string | null,
  ): Promise<{member_role: SettableMemberRole; stranded_room_claims: string[]}> {
    if (memberUserId === orgUserId) {
      throw new ForbiddenException('cannot_modify_org_owner');
    }
    if (actorId !== orgUserId && managerDepartment != null) {
      throw new ForbiddenException('scoped_manager_cannot_change_roles');
    }
    const member = await this.db.qOne<{member_role: SettableMemberRole; status: string}>(
      `SELECT member_role, status FROM org_members
        WHERE org_user_id = $1 AND member_user_id = $2`,
      [orgUserId, memberUserId],
    );
    if (!member) throw new BadRequestException('member_not_found_in_org');
    if (member.status !== 'active') throw new BadRequestException('member_not_active');
    if (member.member_role === newRole) return {member_role: newRole, stranded_room_claims: []};
    // PEER MANAGERS stay owner-protected (critic MEDIUM-2): letting a manager
    // demote a peer would make setMemberStatus's rank rule decorative — demote
    // first, then suspend/remove with full session revocation. The founder's
    // ask is satisfied without it: co-admins PROMOTE ("assign other as admin")
    // and manage staff; only the owner unmakes managers.
    if (actorId !== orgUserId && member.member_role === 'manager') {
      throw new ForbiddenException('only_org_owner_can_demote_managers');
    }
    // Tenant sanity — only the MANAGER pivot is a role change, and the
    // non-manager role is DECIDED BY THE TENANT, never the caller: a demote on
    // a workspace must land on 'employee' and on an agency on 'cpo'. Without
    // the tenant check (edge review HIGH-1) a workspace co-manager could
    // demote a peer to 'cpo' — whose next /auth/me resolves account_kind
    // 'cpo' and drops an office worker into the §35A CPO shell — and an
    // agency admin could demote a manager to 'employee', silently unmaking a
    // deployable CPO.
    if (member.member_role !== 'manager' && newRole !== 'manager') {
      throw new BadRequestException('role_change_not_allowed');
    }
    // The demote target is decided by THE SERVER from the member's evidence —
    // the caller's non-manager value means only "demote". Three rounds of
    // review each broke a different persona by letting a CALLER-side rule
    // pick the role (tenant-derived corrupted agency back-office staff;
    // client-side agent_status corrupted an independent CPO invited into a
    // workspace, whose UNSCOPED agents row disagreed with the server's scoped
    // one — an undemotable manager). A member returns to 'cpo' iff they hold
    // a managed-CPO agents row OF THIS ORG (minted only by createManagedCpo,
    // unspoofable by workspace rows); everyone else returns to 'employee'.
    let effectiveRole: SettableMemberRole = newRole;
    if (newRole !== 'manager') {
      const cpoAgent = await this.db.qOne<{user_id: string}>(
        `SELECT user_id FROM agents
          WHERE user_id = $2 AND managed_by_org_id = $1 AND type = 'cpo'`,
        [orgUserId, memberUserId],
      );
      effectiveRole = cpoAgent ? 'cpo' : 'employee';
    }

    // Conditional on the role we READ (edge review MEDIUM-2): two admins
    // racing promote vs demote both passed the checks above, and the loser's
    // channel sweep then contradicted the winner's roster row — in the bad
    // interleaving the member ended 'employee' yet channel ADMIN with the
    // restricted-channel keys the demote sweep exists to revoke.
    const updated = await this.db.qOne<{member_role: SettableMemberRole}>(
      `UPDATE org_members SET member_role = $3
        WHERE org_user_id = $1 AND member_user_id = $2 AND member_role = $4
        RETURNING member_role`,
      [orgUserId, memberUserId, effectiveRole, member.member_role],
    );
    if (!updated) throw new ConflictException('role_changed_concurrently');

    await this.audit.log(orgUserId, actorId, 'member.role', {
      targetKind: 'user', targetId: memberUserId,
      metadata: {from: member.member_role, to: effectiveRole},
    }).catch(() => {});

    if (effectiveRole === 'manager') {
      // Upserts channel admin on ALL org channels + enqueues add intents.
      // Channels the member already belongs to ack idempotently on drain.
      await this.syncMemberToOrgChannels(orgUserId, memberUserId, 'add', true, actorId);
      return {member_role: effectiveRole, stranded_room_claims: []};
    }
    await this.demoteMemberChannels(orgUserId, memberUserId, actorId);
    return {
      member_role: effectiveRole,
      stranded_room_claims: await this.findStrandedRoomClaims(
        orgUserId, memberUserId, 'demote', actorId),
    };
  }

  // Demotion channel sweep. Best-effort per channel (mirrors
  // syncMemberToOrgChannels): a single channel failure must not abort the
  // roster change — the remaining channels still get their intents.
  private async demoteMemberChannels(orgUserId: string, memberUserId: string, auditActor?: string): Promise<void> {
    const channels = await this.db.q<{id: string; managers_only: boolean}>(
      `SELECT id,
              (access = 'restricted' OR channel_type = 'incident') AS managers_only
         FROM public.department_channels
        WHERE org_id = $1 AND archived_at IS NULL`,
      [orgUserId],
    );
    for (const ch of channels) {
      try {
        if (ch.managers_only) {
          await this.department.removeMember(orgUserId, ch.id, memberUserId, auditActor);
        } else {
          // A7.3 — CLEAR the stored 'Manager' label (null, not a tenant noun):
          // the roster then renders the live noun, so a workspace demotion
          // reads "Member" and an agency one "CPO" without stamping either.
          await this.department.updateMemberRole(orgUserId, ch.id, memberUserId, 'viewer', null, auditActor);
        }
      } catch (e) {
        // not_a_channel_member / member_not_found are fine — nothing to demote.
        this.log.warn(`demote sweep failed for ${memberUserId} on ${ch.id}: ${(e as Error).message}`);
      }
    }
  }
}
