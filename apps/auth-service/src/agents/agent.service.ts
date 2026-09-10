import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import * as crypto from 'node:crypto';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
// Value import for the static CHANNEL constant only — NOT injected (OpsModule
// imports AgentModule, so injecting the bridge would be a DI cycle).
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {NotificationsService} from '../notifications/notifications.service';
import {MissionStateMachine, type MissionStatus} from '../ops/mission-state-machine.service';
import {CpoAssignmentService} from '../booking/assignment/cpo-assignment.service';
import {WalletService} from '../wallet/wallet.service';
import {DepartmentService} from '../department/department.service';
import {ProofOfCompletionService} from './proof-of-completion.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {haversineMeters} from '../ops/mapbox-directions.service';
import {deriveVerifyCode, VERIFY_CODE_WINDOW_MS} from '../dispatch/verify-code.util';
import {SUPPORTED_REGION_CODES} from '../common/regions';
import {
  AgentStateMachine, type AgentActorRole, type AgentStatus,
} from './state-machine.service';
import {
  type AgentTypeDto, type DocSlot, type KycKind, type DeploymentCheckKey,
  type UpdateCompanyDto, type UpdateCoverageDto, type UpdateAvailabilityDto,
  type UploadDocumentDto, type UploadKycDocDto, type DeploymentSignOffDto,
  KYC_KINDS, DEPLOYMENT_CHECKS,
} from './dto/agent.dto';

const REVIEW_STEPS = ['submit', 'docs', 'kyc', 'ops', 'partner'] as const;

// Step 23 anti-fraud — a fix implying > 900 km/h between two duty heartbeats is a
// teleport (faster than commercial-jet cruise), not ground movement → mock-flagged.
// This is a teleport/spoof DETECTOR, not a speed limit; ground CPO units never
// approach it. The check is accuracy-aware + ignores near-simultaneous fixes so
// ordinary GPS jitter can't false-flag a legitimate agency (which would wrongly bench
// them from dispatch).
const MAX_PLAUSIBLE_KPH = 900;
// Don't judge plausibility on fixes less than this apart: at a sub-second dt, ordinary
// position jitter divides into an enormous apparent speed.
const MIN_PLAUSIBILITY_DT_SECONDS = 5;
// A fixed GPS-jitter floor (m) added to the reported accuracies so a poor-signal fix
// is never mistaken for a teleport.
const GPS_JITTER_FLOOR_M = 150;
// FRAUD-3 — cap the per-fix reported-accuracy contribution to the teleport tolerance.
// Uncapped, a spoofer reporting accuracy_m: 10000 bought ~10 km of extra jump room per
// fix and could drift a fake position across a metro. Real fixes are rarely worse than
// this in the open, and the slack is only for jitter, so capping is safe.
const MAX_ACCURACY_SLACK_M = 150;
// FSM-1 — the mission FSM is a pure, stateless table (no deps), so the live agent pipeline
// consults it via a module-level instance rather than crossing the OpsModule↔AgentModule DI
// cycle. One shared TRANSITIONS table = one source of truth.
const missionFsm = new MissionStateMachine();

/** Great-circle distance in km between two WGS-84 points (mean Earth radius). */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface AgentRow {
  user_id: string;
  type: AgentTypeDto;
  status: AgentStatus;
  tier: number;
  call_sign: string | null;
  display_name: string | null;
  rate_aed_per_hour: string | null;
  rating: string | null;
  jobs_total: number;
  duty_hours_mtd: number;
  on_duty: boolean;
  submitted_at: Date | null;
  approved_at: Date | null;
  activated_at: Date | null;
  created_at: Date;
  updated_at: Date;
  // Dispatch geo (Step 2/23) — present via SELECT *; optional on the type.
  last_lat?: string | number | null;
  last_lng?: string | number | null;
  last_location_at?: Date | string | null;
  last_location_accuracy_m?: string | number | null;
  // Bug 3 — dispatch eligibility inputs (present via SELECT *; optional on the type).
  region_code?: string | null;
  dpa_accepted_at?: Date | string | null;
}

export interface ProfileRow {
  user_id: string;
  company: Record<string, unknown>;
  contact: Record<string, unknown>;
  capabilities: string[];
  coverage: {countries: Array<{code: string; on: boolean}>; services: Array<{key: string; on: boolean}>};
  availability: {mode: string; loadout: string[]};
}

export interface KycRow {
  user_id: string;
  kind: KycKind;
  state: 'queued' | 'running' | 'done' | 'failed';
  subject: string | null;
  metadata: Record<string, unknown>;
  started_at: Date | null;
  settled_at: Date | null;
  file_url: string | null;
  file_hash_sha256: string | null;
  uploaded_at: Date | null;
  reviewed_at: Date | null;
  reviewer_id: string | null;
}

export interface DocRow {
  id: string;
  user_id: string;
  slot: DocSlot;
  required: boolean;
  title: string;
  state: 'upload' | 'done' | 'rejected';
  file_url: string | null;
  uploaded_at: Date | null;
  reviewed_at: Date | null;
  reviewer_id: string | null;
}

export interface ReviewRow {
  user_id: string;
  step: (typeof REVIEW_STEPS)[number];
  state: 'pending' | 'in_progress' | 'done' | 'rejected';
  settled_at: Date | null;
  notes: string | null;
}

export interface DeploymentRow {
  user_id: string;
  check_key: DeploymentCheckKey;
  state: 'pending' | 'passed' | 'failed';
  signed_at: Date | null;
  notes: string | null;
}

@Injectable()
export class AgentService {
  private readonly log = new Logger(AgentService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly fsm: AgentStateMachine,
    private readonly redis: RedisService,
    // Audit C1 — payout primitives for agent-completed missions. Both
    // come from cycle-free modules (BookingModule/WalletModule import
    // neither AgentModule), so wiring them here introduces no DI cycle.
    private readonly cpoAssign: CpoAssignmentService,
    private readonly wallet: WalletService,
    // Phase 3 — seed the org chat workspace on company-agent approval.
    // DepartmentModule imports only AuthModule (no AgentModule), so this is
    // cycle-free.
    private readonly department: DepartmentService,
    // Step 10 — proof-of-completion gate for the lead Finish escrow path.
    // ProofOfCompletionService needs only DatabaseService + ConfigService
    // (both @Global), so it introduces no DI cycle.
    private readonly proof: ProofOfCompletionService,
    private readonly config: ConfigService,
    // LM-B3 — realtime status frames on the button-driven mission advance path
    // (the waypoint/telemetry path already emits them). Stateless Redis publisher,
    // provided in AgentModule; no DI cycle. Optional so existing unit specs (which
    // construct AgentService directly) keep working; calls are guarded with `?.`.
    @Optional() private readonly events?: MissionEventsService,
    // LM-N4 — completion wake to the client on a lead Finish. Same optionality.
    @Optional() private readonly bookingPush?: BookingPushBridge,
    // INFRA-8 — durable inbox for the CPO-SOS fan-out (N-20 parity). NotificationsService
    // is @Global, so this is cycle-free (unlike BookingPushBridge, which is not provided
    // in AgentModule → the SOS wake is published inline). Optional so unit specs that
    // construct AgentService directly keep working; the call is `?.`-guarded.
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ─── 01 · Agent create ────────────────────────────────────────

  async create(userId: string, dto: {type: AgentTypeDto; display_name?: string}): Promise<AgentRow> {
    // Self-registration is service-provider ONLY. Individual CPOs/transport do
    // not self-register — they exist solely as managed sub-accounts their
    // provider creates via OrgCpoService.createManagedCpo (which inserts the
    // agents row directly, bypassing this endpoint). Server backstop for the
    // client gate (RoleSelectionScreen / AgentTypeSelect lock to Agency).
    if (dto.type !== 'company') {
      throw new BadRequestException('self_registration_is_service_provider_only');
    }
    // THE MIRROR of workspace.service's `provider_account_cannot_own_workspace`.
    //
    // That side refuses a company agent creating a workspace; this side was
    // unguarded, so the same users.id could be BOTH an agency and a workspace
    // by going the other way round. Channels vs2 P3 keys real behaviour on that
    // distinction — whether new orgs seed default channels, whether an
    // auto-#broadcast is created, whether the #broadcast can be removed — and a
    // dual-tenant account would silently get the wrong tenant's rules on every
    // one of them. The exclusivity has to be true in both directions before
    // anything is allowed to depend on it.
    const workspace = await this.db.qOne<{owner_user_id: string}>(
      `SELECT owner_user_id FROM public.org_workspaces WHERE owner_user_id = $1`,
      [userId],
    );
    if (workspace) {
      throw new BadRequestException('workspace_owner_cannot_be_provider');
    }
    const existing = await this.db.qOne<AgentRow>(
      `SELECT * FROM agents WHERE user_id = $1`, [userId],
    );
    if (existing) {
      throw new BadRequestException('Agent profile already exists for this user');
    }

    const row = await this.db.qOne<AgentRow>(
      `INSERT INTO agents (user_id, type, status, display_name)
       VALUES ($1, $2, 'DRAFT', $3)
       RETURNING *`,
      [userId, dto.type, dto.display_name ?? null],
    );
    if (!row) throw new BadRequestException('Failed to create agent');

    // Flip the user to the SERVICE_PROVIDER role so the app routes them to the
    // provider home. This is the sanctioned role-grant point: it happens on an
    // AUTHENTICATED self-create of a company agent (the caller is logged in and
    // creating their OWN agent profile), NOT on anonymous registration — so it
    // does NOT re-open the P0-V1 hole that removed `role` from /auth/register.
    // Managed CPOs are created via OrgCpoService with role='agent' (the officer
    // home) and never reach this path.
    await this.db.q(
      `UPDATE public.users SET role = 'service_provider' WHERE id = $1`,
      [userId],
    );

    // RS-05 — the caller's existing access token still carries role='individual'.
    // Revoke the live access JTIs so the client's next call 401s and refreshes
    // into a fresh token minted from this new role (refresh() re-reads users.role).
    // We deliberately do NOT revoke the refresh tokens: this is a self-service
    // upgrade, not a security downgrade, so the user must not be bounced to login.
    // Soft-nudge sibling of AuthService.revokeAllUserSessions, kept inline because
    // AgentService already holds `redis` and injecting AuthService would churn the
    // agent spec suite for a 4-line JTI select.
    try {
      const sessions = await this.db.q<{current_jti: string | null}>(
        `SELECT current_jti FROM auth_devices WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await this.redis.revokeJtis(
        sessions.map(s => s.current_jti).filter((j): j is string => j !== null),
      );
    } catch (e) {
      this.log.warn(`role-flip jti revoke failed for ${userId.slice(0, 8)}: ${(e as Error).message}`);
    }

    // RS-11 — record the role change in the queryable ops_audit trail. OpsAuditService
    // isn't injectable here (AgentModule cannot import OpsModule — DI cycle), so write
    // the row directly with the same shape. Best-effort: a missing audit row must not
    // fail agent creation. actor_role='AGENT' + subject_type='user' both pass the
    // ops_audit CHECK constraints.
    try {
      await this.db.q(
        `INSERT INTO ops_audit (actor_id, actor_role, action, subject_type, subject_id, metadata)
         VALUES ($1, 'AGENT', 'user.role.change', 'user', $1, $2::jsonb)`,
        [userId, JSON.stringify({from: 'individual', to: 'service_provider', reason: 'agent_self_create'})],
      );
    } catch (e) {
      this.log.warn(`role-change audit insert failed for ${userId.slice(0, 8)}: ${(e as Error).message}`);
    }

    // Seed profile row + KYC checks + review pipeline + deployment checks.
    await this.db.q(`INSERT INTO agent_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);

    for (const kind of KYC_KINDS) {
      await this.db.q(
        `INSERT INTO agent_kyc_checks (user_id, kind, state)
         VALUES ($1, $2, 'queued')
         ON CONFLICT DO NOTHING`,
        [userId, kind],
      );
    }

    // Seed the 6 doc slots. REQ: sia, passport, insurance, dbs. OPT: firstaid, cv.
    const docSeed: {slot: DocSlot; required: boolean; title: string}[] = [
      {slot: 'sia',       required: true,  title: 'Security License / CPO Profile'},
      {slot: 'passport',  required: true,  title: 'Passport / National ID'},
      {slot: 'insurance', required: true,  title: 'Professional Indemnity Insurance'},
      {slot: 'dbs',       required: true,  title: 'Police Clearance / DBS Enhanced'},
      {slot: 'firstaid',  required: false, title: 'First Aid Certificate'},
      {slot: 'cv',        required: false, title: 'Professional CV / Résumé'},
    ];
    for (const d of docSeed) {
      await this.db.q(
        `INSERT INTO agent_documents (user_id, slot, required, title, state)
         VALUES ($1, $2, $3, $4, 'upload')
         ON CONFLICT (user_id, slot) DO NOTHING`,
        [userId, d.slot, d.required, d.title],
      );
    }

    for (const step of REVIEW_STEPS) {
      await this.db.q(
        `INSERT INTO agent_review_pipeline (user_id, step, state)
         VALUES ($1, $2, 'pending')
         ON CONFLICT DO NOTHING`,
        [userId, step],
      );
    }

    for (const key of DEPLOYMENT_CHECKS) {
      await this.db.q(
        `INSERT INTO agent_deployment_checks (user_id, check_key, state)
         VALUES ($1, $2, 'pending')
         ON CONFLICT DO NOTHING`,
        [userId, key],
      );
    }

    await this.audit(userId, null, 'DRAFT', userId, 'AGENT', {reason: 'agent_created', type: dto.type});

    return row;
  }

  // ─── Read ─────────────────────────────────────────────────────

  async getMe(userId: string): Promise<{
    agent: AgentRow;
    profile: ProfileRow;
    kyc: KycRow[];
    documents: DocRow[];
    review: ReviewRow[];
    deployment: DeploymentRow[];
  }> {
    const agent = await this.requireAgent(userId);
    const [profile, kyc, documents, review, deployment] = await Promise.all([
      this.db.qOne<ProfileRow>(`SELECT * FROM agent_profiles WHERE user_id = $1`, [userId]),
      this.db.q<KycRow>(`SELECT * FROM agent_kyc_checks WHERE user_id = $1 ORDER BY kind`, [userId]),
      this.db.q<DocRow>(`SELECT * FROM agent_documents WHERE user_id = $1 ORDER BY required DESC, slot`, [userId]),
      this.db.q<ReviewRow>(`SELECT * FROM agent_review_pipeline WHERE user_id = $1`, [userId]),
      this.db.q<DeploymentRow>(`SELECT * FROM agent_deployment_checks WHERE user_id = $1 ORDER BY check_key`, [userId]),
    ]);

    if (!profile) throw new NotFoundException('Agent profile missing');

    // Order review rows according to the canonical 5-step pipeline.
    const reviewSorted = REVIEW_STEPS.map(s => review.find(r => r.step === s)!).filter(Boolean);

    return {agent, profile, kyc, documents, review: reviewSorted, deployment};
  }

  // ─── 02 · Company / capabilities ──────────────────────────────

  async updateCompany(userId: string, dto: UpdateCompanyDto): Promise<void> {
    await this.requireAgent(userId);
    const {capabilities, primary_contact, primary_email, primary_phone, ...company} = dto;

    await this.db.q(
      `UPDATE agent_profiles
          SET company = company || $2::jsonb,
              contact = contact || $3::jsonb,
              capabilities = COALESCE($4::jsonb, capabilities)
        WHERE user_id = $1`,
      [
        userId,
        JSON.stringify(company),
        JSON.stringify({primary_contact, primary_email, primary_phone}),
        capabilities ? JSON.stringify(capabilities) : null,
      ],
    );

    // Any profile save transitions DRAFT → PROFILE_COMPLETE.
    await this.transitionIfAt(userId, 'DRAFT', 'PROFILE_COMPLETE', 'AGENT', {reason: 'profile_saved'});
  }

  // ─── 03 · KYC ─────────────────────────────────────────────────

  async startKyc(userId: string): Promise<void> {
    const agent = await this.requireAgent(userId);
    if (agent.status !== 'PROFILE_COMPLETE') {
      throw new BadRequestException(`Cannot start KYC from status ${agent.status}`);
    }
    this.fsm.assert('PROFILE_COMPLETE', 'KYC_PENDING', 'AGENT');
    await this.db.q(`UPDATE agents SET status = 'KYC_PENDING' WHERE user_id = $1`, [userId]);
    await this.db.q(
      `UPDATE agent_kyc_checks
          SET state = 'running', started_at = NOW()
        WHERE user_id = $1 AND state = 'queued'`,
      [userId],
    );
    await this.audit(userId, 'PROFILE_COMPLETE', 'KYC_PENDING', userId, 'AGENT', {reason: 'kyc_start'});
  }

  async settleKyc(
    userId: string,
    kind: KycKind,
    result: 'done' | 'failed',
    subject?: string,
  ): Promise<void> {
    await this.db.q(
      `UPDATE agent_kyc_checks
          SET state = $3, settled_at = NOW(), subject = COALESCE($4, subject)
        WHERE user_id = $1 AND kind = $2`,
      [userId, kind, result, subject ?? null],
    );

    // When every check is either done or failed, move the agent forward.
    const remaining = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n FROM agent_kyc_checks
        WHERE user_id = $1 AND state NOT IN ('done','failed')`,
      [userId],
    );
    if (remaining && Number(remaining.n) === 0) {
      await this.transitionIfAt(userId, 'KYC_PENDING', 'DOCS_PENDING', 'SYSTEM', {reason: 'kyc_settled'});
    }
  }

  /**
   * Agent attaches a supporting document for a KYC slot. Marks the check
   * as `done` (pending ops verification on the console) and records the
   * file URL + optional human-readable subject (e.g. "Passport GB-231122").
   */
  async uploadKycDoc(userId: string, kind: KycKind, dto: UploadKycDocDto): Promise<KycRow> {
    const agent = await this.requireAgent(userId);
    if (agent.status !== 'KYC_PENDING' && agent.status !== 'DOCS_PENDING') {
      throw new BadRequestException(`Cannot upload KYC doc from status ${agent.status}`);
    }
    const row = await this.db.qOne<KycRow>(
      `UPDATE agent_kyc_checks
          SET state = 'done',
              file_url = $3,
              file_hash_sha256 = $4,
              subject = COALESCE($5, subject),
              uploaded_at = NOW(),
              settled_at = NOW()
        WHERE user_id = $1 AND kind = $2
        RETURNING *`,
      [userId, kind, dto.file_url, dto.file_hash_sha256 ?? null, dto.subject ?? null],
    );
    if (!row) throw new NotFoundException(`No KYC slot ${kind}`);

    // Once all 4 KYC checks are uploaded, advance to DOCS_PENDING so the
    // agent can proceed to the supplementary 6-slot doc pack.
    const remaining = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n FROM agent_kyc_checks
        WHERE user_id = $1 AND state NOT IN ('done','failed')`,
      [userId],
    );
    if (remaining && Number(remaining.n) === 0) {
      await this.transitionIfAt(userId, 'KYC_PENDING', 'DOCS_PENDING', 'SYSTEM', {reason: 'kyc_uploads_complete'});
    }
    return row;
  }

  /**
   * Fast-forward the agent past the now-removed KYC screen. This:
   *   1. Auto-runs PROFILE_COMPLETE → KYC_PENDING → DOCS_PENDING
   *   2. Marks all 4 KYC checks `done` with a placeholder subject so ops
   *      still sees a complete KYC summary
   *   3. Mirrors any KYC file_urls already collected into the matching
   *      compliance-pack doc slots (passport ← gov_id, sia ← sia_licence,
   *      dbs ← police), so agents don't re-upload documents they've
   *      already submitted at the KYC stage.
   *
   * Idempotent — no-op once the agent has reached DOCS_PENDING or past.
   */
  async skipKycToDocs(userId: string): Promise<void> {
    const agent = await this.requireAgent(userId);
    if (agent.status === 'PROFILE_COMPLETE') {
      this.fsm.assert('PROFILE_COMPLETE', 'KYC_PENDING', 'AGENT');
      await this.db.q(`UPDATE agents SET status = 'KYC_PENDING' WHERE user_id = $1`, [userId]);
      await this.audit(userId, 'PROFILE_COMPLETE', 'KYC_PENDING', userId, 'AGENT', {reason: 'kyc_skipped'});
    }
    const refreshed = await this.requireAgent(userId);
    if (refreshed.status !== 'KYC_PENDING') return;

    // Settle every still-running/queued KYC check.
    await this.db.q(
      `UPDATE agent_kyc_checks
          SET state = 'done',
              settled_at = COALESCE(settled_at, NOW()),
              subject    = COALESCE(subject, 'Reviewed via compliance pack upload')
        WHERE user_id = $1 AND state IN ('queued', 'running')`,
      [userId],
    );

    // Mirror KYC uploads → matching compliance-pack doc rows.
    const KYC_TO_DOC: Record<string, string> = {
      gov_id: 'passport', sia_licence: 'sia', police: 'dbs',
    };
    const kycRows = await this.db.q<KycRow>(
      `SELECT * FROM agent_kyc_checks WHERE user_id = $1`, [userId],
    );
    for (const k of kycRows) {
      const slot = KYC_TO_DOC[k.kind];
      if (!slot || !k.file_url) continue;
      await this.db.q(
        `UPDATE agent_documents
            SET state = 'done',
                file_url = $3,
                file_hash_sha256 = COALESCE($4, file_hash_sha256),
                uploaded_at = COALESCE(uploaded_at, NOW())
          WHERE user_id = $1 AND slot = $2 AND state <> 'done'`,
        [userId, slot, k.file_url, k.file_hash_sha256],
      );
    }

    this.fsm.assert('KYC_PENDING', 'DOCS_PENDING', 'SYSTEM');
    await this.db.q(`UPDATE agents SET status = 'DOCS_PENDING' WHERE user_id = $1`, [userId]);
    await this.audit(userId, 'KYC_PENDING', 'DOCS_PENDING', userId, 'SYSTEM', {reason: 'kyc_skipped'});
  }

  // ─── 04 · Coverage ────────────────────────────────────────────

  async updateCoverage(userId: string, dto: UpdateCoverageDto): Promise<void> {
    await this.requireAgent(userId);
    await this.db.q(
      `UPDATE agent_profiles SET coverage = $2::jsonb WHERE user_id = $1`,
      [userId, JSON.stringify(dto)],
    );
  }

  // ─── 05 · Availability ────────────────────────────────────────

  async updateAvailability(userId: string, dto: UpdateAvailabilityDto): Promise<void> {
    await this.requireAgent(userId);
    await this.db.q(
      `UPDATE agent_profiles SET availability = $2::jsonb WHERE user_id = $1`,
      [userId, JSON.stringify(dto)],
    );
  }

  // ─── 06 · Documents ───────────────────────────────────────────

  async uploadDocument(userId: string, dto: UploadDocumentDto): Promise<DocRow> {
    await this.requireAgent(userId);
    const row = await this.db.qOne<DocRow>(
      `UPDATE agent_documents
          SET state = 'done', title = $3, file_url = $4,
              file_hash_sha256 = $5, uploaded_at = NOW()
        WHERE user_id = $1 AND slot = $2
        RETURNING *`,
      [userId, dto.slot, dto.title, dto.file_url, dto.file_hash_sha256 ?? null],
    );
    if (!row) throw new NotFoundException(`No document slot ${dto.slot}`);

    // Mirror compliance-pack uploads into the matching KYC check so the
    // ops-console KYC panel reflects real evidence even when the agent
    // skipped the standalone KYC screen.
    const DOC_TO_KYC: Record<string, string> = {
      passport: 'gov_id',
      sia:      'sia_licence',
      dbs:      'police',
    };
    const kycKind = DOC_TO_KYC[dto.slot];
    if (kycKind) {
      await this.db.q(
        `UPDATE agent_kyc_checks
            SET state = 'done',
                file_url         = $3,
                file_hash_sha256 = $4,
                uploaded_at      = COALESCE(uploaded_at, NOW()),
                settled_at       = COALESCE(settled_at, NOW()),
                subject          = COALESCE(subject, $5)
          WHERE user_id = $1 AND kind = $2`,
        [userId, kycKind, dto.file_url, dto.file_hash_sha256 ?? null, dto.title],
      );
      // If all 4 KYC checks are now done, advance to DOCS_PENDING.
      const remaining = await this.db.qOne<{n: string}>(
        `SELECT COUNT(*)::text AS n FROM agent_kyc_checks
          WHERE user_id = $1 AND state NOT IN ('done','failed')`,
        [userId],
      );
      if (remaining && Number(remaining.n) === 0) {
        await this.transitionIfAt(userId, 'KYC_PENDING', 'DOCS_PENDING', 'SYSTEM', {reason: 'kyc_mirrored_from_docs'});
      }
    }

    return row;
  }

  async submitForReview(userId: string): Promise<void> {
    let agent = await this.requireAgent(userId);

    // Why: the PROFILE_COMPLETE → DOCS_PENDING hop is driven by a fire-and-forget
    // client call in the registration wizard. When it never lands, the agent still
    // uploads a full compliance pack (uploadDocument has no status gate) and then
    // dead-ends here with no in-app recovery — B-96. Re-run the idempotent
    // fast-forward so status catches up to the evidence; every hop still goes
    // through fsm.assert and the required-doc gate below still applies.
    if (agent.status === 'PROFILE_COMPLETE' || agent.status === 'KYC_PENDING') {
      await this.skipKycToDocs(userId);
      agent = await this.requireAgent(userId);
    }

    if (agent.status !== 'DOCS_PENDING') {
      throw new BadRequestException(`Cannot submit from status ${agent.status}`);
    }

    // Gate: all REQUIRED documents must be 'done'.
    const missing = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n FROM agent_documents
        WHERE user_id = $1 AND required = TRUE AND state <> 'done'`,
      [userId],
    );
    if (missing && Number(missing.n) > 0) {
      throw new BadRequestException(`${missing.n} required document(s) still missing`);
    }

    this.fsm.assert('DOCS_PENDING', 'SUBMITTED', 'AGENT');
    await this.db.q(
      `UPDATE agents SET status = 'SUBMITTED', submitted_at = NOW() WHERE user_id = $1`,
      [userId],
    );
    await this.db.q(
      `UPDATE agent_review_pipeline SET state = 'done', settled_at = NOW()
        WHERE user_id = $1 AND step = 'submit'`,
      [userId],
    );
    await this.audit(userId, 'DOCS_PENDING', 'SUBMITTED', userId, 'AGENT', {reason: 'submitted'});
  }

  // ─── Ops: mark a compliance-pack doc as reviewed ──────────────

  async reviewDocument(agentId: string, slot: string, reviewerId: string): Promise<DocRow> {
    const row = await this.db.qOne<DocRow>(
      `UPDATE agent_documents
          SET reviewed_at = NOW(), reviewer_id = $3
        WHERE user_id = $1 AND slot = $2
        RETURNING *`,
      [agentId, slot, reviewerId],
    );
    if (!row) throw new NotFoundException(`No document slot ${slot} for agent ${agentId}`);

    // Advance the 'docs' review-pipeline step based on how many required
    // docs have now been reviewed.
    const unreviewedRequired = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n FROM agent_documents
        WHERE user_id = $1 AND required = TRUE AND reviewed_at IS NULL AND state = 'done'`,
      [agentId],
    );
    const allReviewed = unreviewedRequired && Number(unreviewedRequired.n) === 0;

    await this.db.q(
      `UPDATE agent_review_pipeline
          SET state     = $3,
              settled_at = CASE WHEN $3 = 'done' THEN NOW() ELSE settled_at END,
              reviewer_id = $2
        WHERE user_id = $1 AND step = 'docs' AND state <> 'done'`,
      [agentId, reviewerId, allReviewed ? 'done' : 'in_progress'],
    );

    return row;
  }

  // ─── Ops: mark a KYC check as reviewed ────────────────────────

  async reviewKycCheck(agentId: string, kind: string, reviewerId: string): Promise<KycRow> {
    const row = await this.db.qOne<KycRow>(
      `UPDATE agent_kyc_checks
          SET reviewed_at = NOW(), reviewer_id = $3
        WHERE user_id = $1 AND kind = $2
        RETURNING *`,
      [agentId, kind, reviewerId],
    );
    if (!row) throw new NotFoundException(`No KYC check ${kind} for agent ${agentId}`);

    // Advance the 'kyc' review-pipeline step.
    const unreviewedKyc = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n FROM agent_kyc_checks
        WHERE user_id = $1 AND state = 'done' AND reviewed_at IS NULL`,
      [agentId],
    );
    const allKycReviewed = unreviewedKyc && Number(unreviewedKyc.n) === 0;

    await this.db.q(
      `UPDATE agent_review_pipeline
          SET state      = $3,
              settled_at = CASE WHEN $3 = 'done' THEN NOW() ELSE settled_at END,
              reviewer_id = $2
        WHERE user_id = $1 AND step = 'kyc' AND state <> 'done'`,
      [agentId, reviewerId, allKycReviewed ? 'done' : 'in_progress'],
    );

    return row;
  }

  // ─── Available jobs for agents ────────────────────────────────

  async getAvailableJobs(userId: string): Promise<{jobs: Array<{
    id: string; short_code: string; status: string; region_code: string;
    route_label: string; dispatch_at: string; duration_hours: number;
    cpo_slots: number; slots_filled: number; service: string;
    pickup_lat: string | null; pickup_lng: string | null;
    dropoff_lat: string | null; dropoff_lng: string | null;
    applied: boolean; application_status: string | null;
  }>}> {
    await this.requireAgent(userId);
    // Region + proximity scope so a provider only gets requests in their region, near the
    // client (mirrors the auto-dispatch ranker for the legacy job feed). `me` is the
    // requesting agent's dispatch region + last known location:
    //  • Region — when the agent has set a region (agents.region_code, company accounts) only
    //    same-region jobs show; an agent with no region still sees all (legacy, unchanged).
    //  • Proximity — when the fix is FRESH and the job is pinned, jobs beyond the radius are
    //    hidden and the rest are ordered nearest-first; a stale/missing fix or unpinned job
    //    falls back to all in-region jobs, so the feed is never silently emptied.
    const radiusM = Number(process.env.JOB_FEED_RADIUS_M ?? 50_000);
    // Staging-only cross-region testing: DISPATCH_DISABLE_REGION_FILTER drops the
    // feed's region scope so a test provider sees jobs of any region. Guarded from
    // production (main.ts dangerous-flags fail-fast + the NODE_ENV check here).
    const disableRegion = process.env.DISPATCH_DISABLE_REGION_FILTER === 'true'
      && process.env.NODE_ENV !== 'production';
    const jobs = await this.db.q<{
      id: string; short_code: string; status: string; region_code: string;
      route_label: string; dispatch_at: string; duration_hours: number;
      cpo_slots: number; slots_filled: number; service: string;
      pickup_lat: string | null; pickup_lng: string | null;
      dropoff_lat: string | null; dropoff_lng: string | null;
      distance_bucket: string | null;
      applied: boolean; application_status: string | null;
    }>(
      // FRAUD-4 — the legacy job feed is PRE-assignment, so it must NOT leak the
      // principal's exact pickup/dropoff (the auto-dispatch offer is correctly coarse;
      // this path returned raw b.pickup_lat/lng/dropoff to every browsing agent). The
      // coords are still used by the proximity WHERE/ORDER below — server-side, never
      // in the response — while the output carries NULLs (the agent card falls back to
      // its coarse route_label hero band) plus a coarse distance_bucket, mirroring the
      // auto-dispatch coarse offer. Exact coords are revealed only to the ASSIGNED
      // agency via the org mission detail, never in the browse feed.
      `WITH me AS (
         SELECT region_code, last_location, last_location_at
           FROM public.agents WHERE user_id = $1
       )
       SELECT j.id, j.short_code, j.status, j.region_code,
              j.route_label, j.dispatch_at, j.duration_hours,
              j.cpo_slots, j.slots_filled,
              b.service,
              NULL::double precision AS pickup_lat,
              NULL::double precision AS pickup_lng,
              NULL::double precision AS dropoff_lat,
              NULL::double precision AS dropoff_lng,
              CASE
                WHEN me.last_location IS NULL OR b.pickup_lat IS NULL OR b.pickup_lng IS NULL THEN NULL
                WHEN extensions.ST_DWithin(me.last_location, extensions.ST_SetSRID(extensions.ST_MakePoint(b.pickup_lng, b.pickup_lat), 4326)::extensions.geography, 2000)  THEN '<2km'
                WHEN extensions.ST_DWithin(me.last_location, extensions.ST_SetSRID(extensions.ST_MakePoint(b.pickup_lng, b.pickup_lat), 4326)::extensions.geography, 5000)  THEN '2-5km'
                WHEN extensions.ST_DWithin(me.last_location, extensions.ST_SetSRID(extensions.ST_MakePoint(b.pickup_lng, b.pickup_lat), 4326)::extensions.geography, 10000) THEN '5-10km'
                ELSE '>10km'
              END AS distance_bucket,
              (a.id IS NOT NULL) AS applied,
              a.status            AS application_status
         FROM jobs j
         JOIN lite_bookings b ON b.id = j.booking_id
         CROSS JOIN me
         LEFT JOIN job_applications a ON a.job_id = j.id AND a.agent_id = $1
        WHERE j.status = 'PUBLISHED'
          -- Drop jobs whose underlying booking has been cancelled — the
          -- jobs row keeps its PUBLISHED status when a client cancels,
          -- so without this filter cancelled bookings linger in the feed.
          AND b.status <> 'CANCELLED'
          -- Skip full jobs. Without this, agents fill out a dress pledge
          -- for a job they can never be assigned to and get auto-rejected
          -- silently at dispatch time.
          AND j.slots_filled < j.cpo_slots
          -- Hide stale jobs whose dispatch time is already in the past.
          -- A 30-minute grace lets agents still pick up an in-progress job
          -- they're moments late on, but cuts the multi-day stale clutter.
          AND j.dispatch_at > NOW() - INTERVAL '30 minutes'
          -- Region scope: only same-region jobs when the agent has set a region; a null
          -- region (e.g. a managed CPO that never set one) sees all. Bypassed entirely
          -- under DISPATCH_DISABLE_REGION_FILTER for cross-region testing.
          ${disableRegion ? '' : 'AND (me.region_code IS NULL OR j.region_code = me.region_code)'}
          -- Proximity scope: hide out-of-radius jobs ONLY when the agent's fix is fresh and the
          -- job is pinned; otherwise (no/stale fix, or no pin) keep the job so the feed never
          -- empties for an agent who simply isn't reporting location.
          AND (
            me.last_location IS NULL
            OR me.last_location_at IS NULL
            OR me.last_location_at <= NOW() - INTERVAL '15 minutes'
            OR b.pickup_lat IS NULL OR b.pickup_lng IS NULL
            OR extensions.ST_DWithin(
                 me.last_location,
                 extensions.ST_SetSRID(extensions.ST_MakePoint(b.pickup_lng, b.pickup_lat), 4326)::extensions.geography,
                 $2)
          )
        -- Nearest-first when a distance is computable, else FIFO (oldest-published) — matching
        -- the ops console's job pipeline ordering when location isn't available.
        ORDER BY
          CASE WHEN me.last_location IS NOT NULL AND b.pickup_lat IS NOT NULL AND b.pickup_lng IS NOT NULL
            THEN extensions.ST_Distance(
                   me.last_location,
                   extensions.ST_SetSRID(extensions.ST_MakePoint(b.pickup_lng, b.pickup_lat), 4326)::extensions.geography)
            ELSE NULL END ASC NULLS LAST,
          j.published_at ASC
        LIMIT 50`,
      [userId, radiusM],
    );
    return {jobs};
  }

  // Testing affordance — provider region browse. A company (service-provider)
  // agent lists OPEN bookings for any supported region: statuses still in the
  // pre-accept pipeline (PENDING_OPS / OPS_APPROVED / DISPATCHING — never
  // CONFIRMED or a terminal state), FIFO by created_at, LIMIT 50.
  // Why: LB1 coarse-only pre-accept — the SELECT + the explicit field map below
  // structurally exclude pickup/dropoff coords, full addresses and client
  // identity; pickup_address is truncated to its first segment (zone) in SQL.
  async browseOpenJobs(userId: string, region?: string): Promise<{jobs: Array<{
    booking_id: string; status: string; region_code: string; region_label: string;
    service: string; pickup_area: string | null; pickup_time: Date;
    duration_hours: number; cpo_count: number; armed_required: boolean;
    total_eur: string; total_aed: string; created_at: Date; dispatch_mode: string | null;
  }>}> {
    const agent = await this.requireAgent(userId);
    if (agent.type !== 'company') {
      throw new ForbiddenException('provider_only');
    }
    const code = (region ?? '').trim().toUpperCase();
    if (code && code !== 'ALL' && !SUPPORTED_REGION_CODES.includes(code)) {
      throw new BadRequestException('unsupported_region');
    }
    const regionFilter = code && code !== 'ALL' ? code : null;
    const rows = await this.db.q<{
      booking_id: string; status: string; region_code: string; region_label: string;
      service: string; pickup_area: string | null; pickup_time: Date;
      duration_hours: number; cpo_count: number; armed_required: boolean;
      total_eur: string; total_aed: string; created_at: Date; dispatch_mode: string | null;
    }>(
      `SELECT b.id AS booking_id, b.status, b.region_code, b.region_label,
              b.service, split_part(b.pickup_address, ',', 1) AS pickup_area,
              b.pickup_time, b.duration_hours, b.cpo_count, b.armed_required,
              b.total_eur, b.total_aed, b.created_at, b.dispatch_mode
         FROM public.lite_bookings b
        WHERE b.status IN ('PENDING_OPS','OPS_APPROVED','DISPATCHING')
          AND ($1::text IS NULL OR b.region_code = $1)
        ORDER BY b.created_at ASC
        LIMIT 50`,
      [regionFilter],
    );
    // Explicit allow-list map — even a future SELECT * drift can't widen the response.
    return {jobs: rows.map(r => ({
      booking_id: r.booking_id,
      status: r.status,
      region_code: r.region_code,
      region_label: r.region_label,
      service: r.service,
      pickup_area: r.pickup_area,
      pickup_time: r.pickup_time,
      duration_hours: r.duration_hours,
      cpo_count: r.cpo_count,
      armed_required: r.armed_required,
      total_eur: r.total_eur,
      total_aed: r.total_aed,
      created_at: r.created_at,
      // Why: only an auto booking is claimable (charge-on-accept consent exists);
      // the card disables ACCEPT for legacy rows instead of 409ing on tap.
      dispatch_mode: r.dispatch_mode,
    }))};
  }

  /** Detail view for a single job, including booking summary + my apply state. */
  async getJobDetail(userId: string, jobId: string) {
    await this.requireAgent(userId);
    const job = await this.db.qOne<{
      id: string; booking_id: string; short_code: string; status: string;
      region_code: string; route_label: string; dispatch_at: Date;
      duration_hours: number; cpo_slots: number; slots_filled: number;
      published_at: Date;
    }>(
      `SELECT id, booking_id, short_code, status, region_code, route_label,
              dispatch_at, duration_hours, cpo_slots, slots_filled, published_at
         FROM jobs WHERE id = $1`,
      [jobId],
    );
    if (!job) throw new NotFoundException('Job not found');

    // IDOR fix (Step 22) — precise pickup/drop-off coordinates, full addresses and
    // client notes are PII. requireAgent only proves the caller is *an* agent, not
    // that they have a stake in *this* job, so without a gate any agent could harvest
    // a client's home/destination by enumerating jobIds. Gate the precise fields on a
    // non-REJECTED application: the coarse browse summary (region, route label, time,
    // price, slots) stays open so an agent can still decide whether to apply, but the
    // exact location is only revealed once they have actually applied (and weren't
    // rejected). Mirrors the crew-only mission gate from Step 21.
    const application = await this.db.qOne<{
      id: string; status: string; applied_at: Date;
    }>(
      `SELECT id, status, applied_at FROM job_applications
        WHERE job_id = $1 AND agent_id = $2`,
      [jobId, userId],
    );
    const hasStake = !!application && application.status !== 'REJECTED';

    const bookingRow = await this.db.qOne<{
      pickup_address: string; pickup_lat: string | null; pickup_lng: string | null;
      dropoff_address: string | null; dropoff_lat: string | null; dropoff_lng: string | null;
      pickup_time: Date; total_eur: string; total_aed: string;
      cpo_count: number; vehicle_count: number; driver_only: boolean;
      passengers: number; add_ons: unknown; notes: string | null;
      service: string; region_label: string; dress_instructions: string | null;
      task_type: string | null; duration_hours: number; exec_transport: unknown | null;
    }>(
      // R-6 — the legacy job-feed lane omitted the executive brief, so solo agents
      // applied for exec bookings partially blind (post-assignment deployment was
      // complete; the application decision was not).
      `SELECT pickup_address, pickup_lat, pickup_lng,
              dropoff_address, dropoff_lat, dropoff_lng,
              pickup_time, total_eur, total_aed,
              cpo_count, vehicle_count, driver_only,
              passengers, add_ons, notes, service, region_label,
              dress_instructions, task_type, duration_hours, exec_transport
         FROM lite_bookings WHERE id = $1`,
      [job.booking_id],
    );
    const booking = bookingRow && !hasStake
      ? {
          ...bookingRow,
          pickup_address: null, pickup_lat: null, pickup_lng: null,
          dropoff_address: null, dropoff_lat: null, dropoff_lng: null,
          notes: null,
          // exec_transport carries transfer ADDRESSES — those stay gated like
          // pickup. But the job feed IS the pre-application surface, so nulling
          // the whole object made every exec job advertise "Transfer: None" to
          // the very agents R-6 was meant to inform. Keep the coordinate-free
          // shape (does a transfer leg exist, and of what kind).
          exec_transport: (bookingRow.exec_transport as {mode?: string} | null)?.mode
            ? {mode: (bookingRow.exec_transport as {mode: string}).mode}
            : null,
        }
      : bookingRow;

    return {job, booking, application, location_revealed: hasStake};
  }

  /**
   * Mission post-mortem the agent's "recent payouts" rows tap into.
   * Returns enough to render a single-screen summary: route + distance
   * + duration + the agent's own payout (with deduction reason if ops
   * docked pay). 404s when the agent never crewed this booking — the
   * `mission_payouts` join is the gate, not a separate auth check.
   */
  async getPayoutSummary(userId: string, bookingId: string): Promise<{
    mission: {id: string; short_code: string; status: string; started_at: string | null; ended_at: string | null;
              route_distance_m: number | null; route_duration_s: number | null};
    booking: {id: string; pickup_address: string; dropoff_address: string | null;
              pickup_time: string; service: string; region_label: string;
              total_eur: string; total_aed: string; cpo_count: number};
    payout:  {paid_credits: number; proposed_credits: number; deduction_credits: number;
              deduction_reason: string | null; decided_at: string};
  }> {
    await this.requireAgent(userId);
    const row = await this.db.qOne<{
      m_id: string; m_short_code: string; m_status: string;
      m_started_at: string | null; m_ended_at: string | null;
      m_route_distance_m: number | null; m_route_duration_s: number | null;
      b_id: string; b_pickup_address: string; b_dropoff_address: string | null;
      b_pickup_time: string; b_service: string; b_region_label: string;
      b_total_eur: string; b_total_aed: string; b_cpo_count: number;
      p_paid_credits: number; p_proposed_credits: number;
      p_deduction_credits: number; p_deduction_reason: string | null;
      p_decided_at: string;
    }>(
      `SELECT
         m.id AS m_id, m.short_code AS m_short_code, m.status AS m_status,
         m.started_at AS m_started_at, m.ended_at AS m_ended_at,
         m.route_distance_m AS m_route_distance_m, m.route_duration_s AS m_route_duration_s,
         b.id AS b_id, b.pickup_address AS b_pickup_address, b.dropoff_address AS b_dropoff_address,
         b.pickup_time AS b_pickup_time, b.service AS b_service, b.region_label AS b_region_label,
         b.total_eur AS b_total_eur, b.total_aed AS b_total_aed, b.cpo_count AS b_cpo_count,
         mp.paid_credits AS p_paid_credits, mp.proposed_credits AS p_proposed_credits,
         mp.deduction_credits AS p_deduction_credits, mp.deduction_reason AS p_deduction_reason,
         mp.decided_at AS p_decided_at
       FROM mission_payouts mp
       JOIN missions m       ON m.id = mp.mission_id
       JOIN lite_bookings b  ON b.id = mp.booking_id
      WHERE mp.booking_id = $1 AND mp.agent_user_id = $2
      LIMIT 1`,
      [bookingId, userId],
    );
    if (!row) throw new NotFoundException('payout_not_found');
    return {
      mission: {
        id: row.m_id, short_code: row.m_short_code, status: row.m_status,
        started_at: row.m_started_at, ended_at: row.m_ended_at,
        route_distance_m: row.m_route_distance_m, route_duration_s: row.m_route_duration_s,
      },
      booking: {
        id: row.b_id, pickup_address: row.b_pickup_address, dropoff_address: row.b_dropoff_address,
        pickup_time: row.b_pickup_time, service: row.b_service, region_label: row.b_region_label,
        total_eur: row.b_total_eur, total_aed: row.b_total_aed, cpo_count: row.b_cpo_count,
      },
      payout: {
        paid_credits: row.p_paid_credits, proposed_credits: row.p_proposed_credits,
        deduction_credits: row.p_deduction_credits, deduction_reason: row.p_deduction_reason,
        decided_at: row.p_decided_at,
      },
    };
  }

  /** Agent applies to a published job. Idempotent on (job_id, agent_id). */
  async applyToJob(userId: string, jobId: string, dressPledge: string): Promise<{application: {
    id: string; job_id: string; agent_id: string; agent_call_sign: string;
    status: string; applied_at: string;
  }}> {
    const pledge = (dressPledge ?? '').trim();
    if (pledge.length < 4) {
      throw new BadRequestException('dress_pledge_required');
    }
    const agent = await this.requireAgent(userId);
    if (agent.status !== 'ACTIVE' && agent.status !== 'APPROVED') {
      throw new BadRequestException('agent_not_approved');
    }
    const job = await this.db.qOne<{id: string; status: string; cpo_slots: number; slots_filled: number}>(
      `SELECT id, status, cpo_slots, slots_filled FROM jobs WHERE id = $1`,
      [jobId],
    );
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== 'PUBLISHED') throw new BadRequestException('job_not_open');

    const callSign = agent.call_sign && agent.call_sign.trim().length > 0
      ? agent.call_sign
      : `AGT-${userId.slice(0, 4).toUpperCase()}`;

    // Org/officer split (Phase 2). A self-applying agent IS the officer; the
    // payee is their owning org if they're a managed CPO, else themselves.
    // agent_id stays the applicant (the UNIQUE(job_id, agent_id) still means
    // "one application per applicant"). For self-apply, applicant == officer.
    const owning = await this.db.qOne<{org_user_id: string}>(
      `SELECT org_user_id FROM org_members
        -- vs2 item 4 — ROLE-FILTERED. Multi-org membership means a CPO can
        -- also be an 'employee' of a company workspace, and an older
        -- employee row would otherwise win this ORDER BY and answer with
        -- the wrong org. This resolver decides EMPLOYMENT (and downstream,
        -- who gets paid), so it must only ever consider the CPO membership
        -- — which the new org_members_one_active_cpo index keeps unique.
        WHERE member_user_id = $1 AND status = 'active' AND member_role = 'cpo'
        ORDER BY created_at ASC LIMIT 1`,
      [userId],
    );
    const applicantOrgId = owning?.org_user_id ?? userId;

    // Re-applies (after WITHDRAWN/REJECTED) refresh both the pledge and
    // the timestamp so ops always sees the most recent commitment.
    const upserted = await this.db.qOne<{
      id: string; job_id: string; agent_id: string; agent_call_sign: string;
      status: string; applied_at: string;
    }>(
      `INSERT INTO job_applications
         (job_id, agent_id, agent_call_sign, status, dress_pledge, dress_pledged_at,
          applicant_org_id, assigned_cpo_user_id)
         VALUES ($1, $2, $3, 'PENDING', $4, NOW(), $5, $2)
       ON CONFLICT (job_id, agent_id) DO UPDATE
         SET dress_pledge     = EXCLUDED.dress_pledge,
             dress_pledged_at = EXCLUDED.dress_pledged_at,
             applicant_org_id = EXCLUDED.applicant_org_id,
             assigned_cpo_user_id = EXCLUDED.assigned_cpo_user_id
       RETURNING id, job_id, agent_id, agent_call_sign, status, applied_at`,
      [jobId, userId, callSign, pledge, applicantOrgId],
    );

    if (!upserted) throw new BadRequestException('apply_failed');
    return {application: upserted};
  }

  /** Withdraw a pending application (allowed only while still PENDING). */
  async withdrawApplication(userId: string, jobId: string): Promise<{ok: true}> {
    const row = await this.db.qOne<{status: string}>(
      `SELECT status FROM job_applications WHERE job_id = $1 AND agent_id = $2`,
      [jobId, userId],
    );
    if (!row) throw new NotFoundException('Application not found');
    if (row.status !== 'PENDING' && row.status !== 'SHORTLISTED') {
      throw new BadRequestException('cannot_withdraw_after_decision');
    }
    await this.db.q(
      `UPDATE job_applications SET status = 'WITHDRAWN', decided_at = now()
        WHERE job_id = $1 AND agent_id = $2`,
      [jobId, userId],
    );
    return {ok: true};
  }

  /** All applications the agent has submitted, joined with the job summary. */
  async getMyApplications(userId: string) {
    const rows = await this.db.q<{
      id: string; status: string; applied_at: string;
      job_id: string; short_code: string; route_label: string;
      dispatch_at: string; duration_hours: number; cpo_slots: number;
      slots_filled: number; job_status: string;
    }>(
      `SELECT a.id, a.status, a.applied_at,
              j.id   AS job_id, j.short_code, j.route_label,
              j.dispatch_at, j.duration_hours, j.cpo_slots, j.slots_filled,
              j.status AS job_status
         FROM job_applications a
         JOIN jobs j ON j.id = a.job_id
        WHERE a.agent_id = $1
        ORDER BY a.applied_at DESC`,
      [userId],
    );
    return {applications: rows};
  }

  /**
   * Latest active mission this agent is crewed on, used by the agent
   * dashboard's "Next on Ops" card. Returns null when the agent has no
   * mission in DISPATCHED/PICKUP/LIVE/SOS state — caller renders the
   * empty "Apply for jobs" hero in that case.
   */
  async getMyActiveMission(userId: string): Promise<{
    mission_id: string;
    short_code: string;
    status: string;
    is_lead: boolean;
    role: string;
    pickup_address: string;
    dropoff_address: string | null;
    pickup_time: string;
    region_label: string | null;
    // FRAUD-2 / P0 — so the CPO's arrival-handshake UI can render "verified"
    // persistently (and hide the entry input) without a second round-trip.
    identity_verified: boolean;
  } | null> {
    const row = await this.db.qOne<{
      mission_id: string; short_code: string; status: string;
      is_lead: boolean; role: string;
      pickup_address: string; dropoff_address: string | null;
      pickup_time: Date; region_label: string | null;
      identity_verified: boolean;
    }>(
      `SELECT m.id AS mission_id, m.short_code, m.status,
              mc.is_lead, mc.role,
              b.pickup_address, b.dropoff_address, b.pickup_time, b.region_label,
              (m.identity_verified_at IS NOT NULL) AS identity_verified
         FROM mission_crew mc
         JOIN missions m       ON m.id = mc.mission_id
         JOIN lite_bookings b  ON b.id = m.booking_id
        WHERE mc.agent_id = $1
          AND m.status IN ('DISPATCHED','PICKUP','LIVE','SOS')
        ORDER BY m.started_at DESC
        LIMIT 1`,
      [userId],
    );
    if (!row) return null;
    return {
      mission_id: row.mission_id,
      short_code: row.short_code,
      status: row.status,
      is_lead: row.is_lead,
      role: row.role,
      pickup_address: row.pickup_address,
      dropoff_address: row.dropoff_address,
      pickup_time: row.pickup_time.toISOString(),
      region_label: row.region_label,
      identity_verified: row.identity_verified,
    };
  }

  /**
   * Past missions the agent crewed (terminal states), newest first, joined
   * with the agent's own payout for that booking when one exists. Powers the
   * "my missions" history list on the agent app — previously the only way to
   * reach a closed mission was to already know its bookingId and hit
   * `getPayoutSummary`, so the app had no list view at all.
   */
  async getMyMissionHistory(userId: string, limit = 50): Promise<Array<{
    mission_id: string;
    booking_id: string;
    short_code: string;
    status: string;
    role: string;
    is_lead: boolean;
    started_at: string | null;
    ended_at: string | null;
    route_distance_m: number | null;
    route_duration_s: number | null;
    pickup_address: string;
    dropoff_address: string | null;
    region_label: string | null;
    paid_credits: number | null;
    deduction_credits: number | null;
  }>> {
    await this.requireAgent(userId);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const rows = await this.db.q<{
      mission_id: string; booking_id: string; short_code: string; status: string;
      role: string; is_lead: boolean; started_at: string | null; ended_at: string | null;
      route_distance_m: number | null; route_duration_s: number | null;
      pickup_address: string; dropoff_address: string | null; region_label: string | null;
      paid_credits: number | null; deduction_credits: number | null;
    }>(
      `SELECT m.id AS mission_id, m.booking_id, m.short_code, m.status,
              mc.role, mc.is_lead, m.started_at, m.ended_at,
              m.route_distance_m, m.route_duration_s,
              b.pickup_address, b.dropoff_address, b.region_label,
              mp.paid_credits, mp.deduction_credits
         FROM mission_crew mc
         JOIN missions m       ON m.id = mc.mission_id
         JOIN lite_bookings b  ON b.id = m.booking_id
         LEFT JOIN mission_payouts mp
                ON mp.mission_id = m.id AND mp.agent_user_id = mc.agent_id
        WHERE mc.agent_id = $1
          AND m.status IN ('COMPLETED','ABORTED')
        ORDER BY m.ended_at DESC NULLS LAST, m.started_at DESC
        LIMIT $2`,
      [userId, safeLimit],
    );
    return rows.map(r => ({
      mission_id: r.mission_id,
      booking_id: r.booking_id,
      short_code: r.short_code,
      status: r.status,
      role: r.role,
      is_lead: r.is_lead,
      started_at: r.started_at,
      ended_at: r.ended_at,
      route_distance_m: r.route_distance_m,
      route_duration_s: r.route_duration_s,
      pickup_address: r.pickup_address,
      dropoff_address: r.dropoff_address,
      region_label: r.region_label,
      paid_credits: r.paid_credits === null ? null : Number(r.paid_credits),
      deduction_credits: r.deduction_credits === null ? null : Number(r.deduction_credits),
    }));
  }

  // ─── Mission deployment (per-mission checks, polled by mobile) ──

  async getMyMissionDeployment(userId: string, missionId: string) {
    const [checks, mission, crew, dress, waypoints, booking, crewList, hourlyCheckins] = await Promise.all([
      this.db.q<DeploymentRow>(
        `SELECT check_key, state, signed_at, notes
           FROM agent_deployment_checks
          WHERE user_id = $1 AND mission_id = $2
          ORDER BY check_key`,
        [userId, missionId],
      ),
      this.db.qOne<{
        short_code: string; status: string; booking_id: string;
        route_distance_m: number | null; route_duration_s: number | null;
        route_polyline: string | null;
        current_lat: number | null; current_lng: number | null;
        current_heading_deg: number | null;
        // Step 29 — the principal's own last-known GPS (client-ping), so the live
        // map can draw the user marker alongside the CPO leader. Crew-gated below.
        client_lat: number | null; client_lng: number | null;
        client_recorded_at: Date | null;
        comms_channel_id: string | null;
        pickup_at: Date | null; live_at: Date | null;
      }>(
        // B-89 MG-02 — heading_deg is WRITTEN on every telemetry push but was
        // never SELECTed here, so the tracker's direction cone stayed frozen
        // north (the client reads `current_heading_deg`).
        `SELECT short_code, status, booking_id,
                route_distance_m, route_duration_s, route_polyline,
                current_lat, current_lng,
                heading_deg AS current_heading_deg,
                client_lat, client_lng, client_recorded_at,
                comms_channel_id,
                pickup_at, live_at
           FROM missions WHERE id = $1`,
        [missionId],
      ),
      this.db.qOne<{
        is_lead: boolean; team_idx: number; role: string; call_sign: string;
        accepted_at: Date | null; declined_at: Date | null;
      }>(
        // B-377 — accepted_at/declined_at drive the officer's own accept/decline
        // card (the /respond endpoint existed with no client; the projection
        // waited on an acceptance nobody could send).
        `SELECT is_lead, team_idx, role, call_sign, accepted_at, declined_at
           FROM mission_crew
          WHERE mission_id = $1 AND agent_id = $2 AND status <> 'off'`,
        [missionId, userId],
      ),
      this.db.qOne<{dress_instructions: string | null; dress_acknowledged_at: Date | null}>(
        `SELECT b.dress_instructions, mc.dress_acknowledged_at
           FROM mission_crew mc
           JOIN missions m       ON m.id = mc.mission_id
           JOIN lite_bookings b  ON b.id = m.booking_id
          WHERE mc.mission_id = $1 AND mc.agent_id = $2`,
        [missionId, userId],
      ),
      this.db.q<{seq: number; tag: string; event: string; state: string; settled_at: Date | null; marked_via: string | null}>(
        `SELECT seq, tag, event, state, settled_at, marked_via
           FROM mission_waypoints WHERE mission_id = $1 ORDER BY seq`,
        [missionId],
      ),
      // booking_status + the principal's name ride here (Step 21) — a CPO on the detail
      // legitimately needs to know who they're protecting; the membership gate below keeps
      // it to crew only.
      this.db.qOne<{
        pickup_address: string; pickup_lat: string | null; pickup_lng: string | null;
        dropoff_address: string | null; dropoff_lat: string | null; dropoff_lng: string | null;
        booking_status: string; client_name: string | null;
        // Executive Protection — the CPO needs the product, task, block length and brief
        // to run the detail; null/irrelevant on non-executive bookings.
        service: string; task_type: string | null; duration_hours: number;
        notes: string | null; exec_transport: unknown | null;
      }>(
        `SELECT b.pickup_address, b.pickup_lat, b.pickup_lng,
                b.dropoff_address, b.dropoff_lat, b.dropoff_lng,
                b.status AS booking_status, u.display_name AS client_name,
                b.service, b.task_type, b.duration_hours, b.notes, b.exec_transport
           FROM missions m
           JOIN lite_bookings b ON b.id = m.booking_id
           LEFT JOIN public.users u ON u.id = b.client_id
          WHERE m.id = $1`,
        [missionId],
      ),
      // Step 21 — the full crew roster for the assigned-mission detail (lead starred + YOU).
      this.db.q<{call_sign: string | null; role: string; team_idx: number; is_lead: boolean; is_me: boolean}>(
        `SELECT call_sign, role, team_idx, is_lead, (agent_id = $2) AS is_me
           FROM mission_crew
          WHERE mission_id = $1 AND status <> 'off'
          ORDER BY is_lead DESC, team_idx`,
        [missionId, userId],
      ),
      // Executive Protection — the hourly timeline (empty for non-executive missions).
      this.db.q<{hour_index: number; status: string; comment: string | null; created_at: Date}>(
        `SELECT hour_index, status, comment, created_at
           FROM mission_hourly_checkins
          WHERE mission_id = $1
          ORDER BY hour_index`,
        [missionId],
      ),
    ]);
    // SECURITY — membership gate (closes a pre-existing IDOR). `crew` (the caller's row) is
    // null unless they're on THIS mission's crew; without this, any authenticated agent could
    // read another mission's pickup/dropoff coords + principal name. Crew-only from here.
    if (!crew) {
      throw new ForbiddenException('not_assigned_to_mission');
    }
    return {
      checks,
      // Step 29 — normalize the principal-position timestamp to ISO for the client.
      mission: mission
        ? {
            ...mission,
            client_recorded_at: mission.client_recorded_at?.toISOString() ?? null,
            pickup_at: mission.pickup_at?.toISOString?.() ?? (mission.pickup_at as unknown as string | null),
            live_at: mission.live_at?.toISOString?.() ?? (mission.live_at as unknown as string | null),
          }
        : null,
      crew_role: {
        is_lead: crew.is_lead, team_idx: crew.team_idx, role: crew.role, call_sign: crew.call_sign,
        accepted_at: crew.accepted_at?.toISOString?.() ?? (crew.accepted_at as unknown as string | null),
        declined_at: crew.declined_at?.toISOString?.() ?? (crew.declined_at as unknown as string | null),
      },
      dress_instructions: dress?.dress_instructions ?? null,
      dress_acknowledged_at: dress?.dress_acknowledged_at?.toISOString() ?? null,
      waypoints: waypoints.map(w => ({
        seq: w.seq, tag: w.tag, event: w.event, state: w.state,
        settled_at: w.settled_at?.toISOString() ?? null,
        marked_via: w.marked_via,
      })),
      booking,
      crew: crewList,
      hourly_checkins: hourlyCheckins.map(h => ({
        hour_index: h.hour_index, status: h.status, comment: h.comment,
        created_at: h.created_at?.toISOString?.() ?? String(h.created_at),
      })),
    };
  }

  /**
   * Agent triggers SOS on a mission they're crewed on. Validates crew
   * membership (so a stale or rotated JWT can't fire SOS on a stranger's
   * mission), inserts the sos_events row, flips mission status to SOS,
   * and posts a system message to the mission ops room.
   *
   * Idempotency-safe at the request level: the IdempotencyInterceptor
   * collapses retries within 24h onto the cached response. A duplicate
   * key from the same agent on the same mission within the window
   * returns the original sos row.
   */
  /**
   * Issue 41 — the assigned officer accepts (or declines) their assignment.
   *
   * Idempotent: accepting twice is a no-op, and the conditional UPDATE means a
   * decline cannot overwrite an accept or vice versa. This does NOT move escrow
   * (still held at provider-accept) and does NOT change missions.status — it
   * flips the client-facing projection only, so the client stops being told the
   * team is dispatched before anyone agreed to go.
   */
  async respondToAssignment(
    userId: string,
    missionId: string,
    action: 'accept' | 'decline',
    reason?: string,
  ): Promise<{ok: true; accepted: boolean}> {
    const crew = await this.db.qOne<{agent_id: string}>(
      `SELECT agent_id FROM mission_crew
        WHERE mission_id = $1 AND agent_id = $2 AND status <> 'off'`,
      [missionId, userId],
    );
    if (!crew) throw new NotFoundException('not_assigned_to_mission');

    const mission = await this.db.qOne<{status: string}>(
      `SELECT status FROM missions WHERE id = $1`, [missionId],
    );
    if (!mission) throw new NotFoundException('mission_not_found');
    // B-377 review — the acceptance window is DISPATCHED only. Without this a
    // stale card (the lead moved the mission on from another device) could land
    // a decline on a RUNNING mission and page the agency mid-detail.
    if (mission.status !== 'DISPATCHED') {
      throw new BadRequestException({
        code: 'respond_window_closed',
        message: `This mission has already moved to ${mission.status}.`,
      });
    }

    if (action === 'accept') {
      // First write wins; a re-tap is a no-op rather than a second timestamp.
      const upd = await this.db.q(
        `UPDATE mission_crew SET accepted_at = NOW(), declined_at = NULL, decline_reason = NULL
          WHERE mission_id = $1 AND agent_id = $2 AND accepted_at IS NULL
          RETURNING agent_id`,
        [missionId, userId],
      );
      if (upd.length > 0) {await this.notifyProviderOfResponse(missionId, true);}
      return {ok: true, accepted: true};
    }
    const upd = await this.db.q(
      `UPDATE mission_crew SET declined_at = NOW(), decline_reason = $3
        WHERE mission_id = $1 AND agent_id = $2 AND accepted_at IS NULL
        RETURNING agent_id`,
      [missionId, userId, (reason ?? '').slice(0, 200) || null],
    );
    // Issue 41 — a decline used to be recorded and go nowhere: the provider was
    // never told, so the client's rail sat at "assigning team" until somebody
    // happened to look at the board. There is still no AUTOMATIC reassignment
    // (that needs the escrow-timing decision, fix plan §10 Q4) — but the party
    // who must re-crew now finds out. Only on the first write, so a re-tap does
    // not re-wake them.
    if (upd.length > 0) {await this.notifyProviderOfResponse(missionId, false);}
    return {ok: true, accepted: false};
  }

  /** Issue 41 — wake the assigned provider with the officer's answer.
   *  Best-effort: the response is already committed, and losing a push must
   *  never fail the officer's accept/decline. */
  private async notifyProviderOfResponse(missionId: string, accepted: boolean): Promise<void> {
    try {
      const row = await this.db.qOne<{booking_id: string; provider_user_id: string | null}>(
        `SELECT m.booking_id, b.assigned_provider_user_id AS provider_user_id
           FROM missions m JOIN lite_bookings b ON b.id = m.booking_id
          WHERE m.id = $1`,
        [missionId],
      );
      if (!row?.provider_user_id) {return;}
      await this.bookingPush?.missionResponse(
        row.provider_user_id, missionId, row.booking_id, accepted,
      );
    } catch (e) {
      this.log.warn(`mission-response notify failed for ${missionId}: ${(e as Error).message}`);
    }
  }

  async raiseSos(
    userId: string,
    missionId: string,
    dto: {reason: string; lat?: number; lng?: number},
  ): Promise<{ok: true; sos_event_id: string}> {
    const crew = await this.db.qOne<{call_sign: string | null}>(
      `SELECT call_sign FROM mission_crew WHERE mission_id = $1 AND agent_id = $2`,
      [missionId, userId],
    );
    if (!crew) throw new NotFoundException('not_assigned_to_mission');

    const mission = await this.db.qOne<{id: string; status: string; short_code: string; comms_channel_id: string | null}>(
      `SELECT id, status, short_code, comms_channel_id FROM missions WHERE id = $1`,
      [missionId],
    );
    if (!mission) throw new NotFoundException('mission_not_found');
    if (mission.status === 'COMPLETED' || mission.status === 'ABORTED') {
      throw new BadRequestException(`Cannot raise SOS on ${mission.status} mission`);
    }

    const sos = await this.db.withTransaction(async tx => {
      // Flip mission → SOS conditionally so two parallel SOS calls
      // don't double-write the audit / Ops Room post.
      if (mission.status !== 'SOS') {
        // FSM-1 — assert the AGENT SOS transition. Skip terminal froms: the WHERE below
        // no-ops on COMPLETED/ABORTED, and asserting SOS-from-terminal would (correctly)
        // throw — preserve the existing silent no-op for an already-ended mission.
        if (mission.status !== 'COMPLETED' && mission.status !== 'ABORTED') {
          missionFsm.assert(mission.status as MissionStatus, 'SOS', 'AGENT');
        }
        const upd = await tx.q(
          `UPDATE missions SET status = 'SOS', updated_at = NOW()
            WHERE id = $1 AND status NOT IN ('SOS','COMPLETED','ABORTED')
            RETURNING id`,
          [missionId],
        );
        // upd.length === 0 means another writer already flipped to SOS —
        // safe to continue with the INSERT.
        void upd;
      }
      const row = await tx.qOne<{id: string}>(
        `INSERT INTO sos_events (mission_id, agent_id, agent_call_sign, reason, lat, lng)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [missionId, userId, crew.call_sign, dto.reason, dto.lat ?? null, dto.lng ?? null],
      );
      if (!row) throw new BadRequestException('Failed to record SOS');
      return row;
    });

    // Fire-and-forget FCM fanout to all OTHER crew members + the
    // principal. The raising agent already has the in-app feedback;
    // everyone else needs a heads-up notification. Publish on the same
    // `push:events` channel BookingPushBridge uses; messenger-service
    // subscribes and fans via FCM.
    try {
      const recipients = await this.db.q<{user_id: string}>(
        // F5 — include the AGENCY monitoring desk (assigned provider) in the
        // fan-out; it was previously blind to a crew-raised SOS.
        `SELECT agent_id AS user_id FROM mission_crew
            WHERE mission_id = $1 AND agent_id <> $2
          UNION
          SELECT client_id AS user_id FROM lite_bookings b
            JOIN missions m ON m.booking_id = b.id
           WHERE m.id = $1
          UNION
          SELECT b.assigned_provider_user_id AS user_id FROM lite_bookings b
            JOIN missions m ON m.booking_id = b.id
           WHERE m.id = $1 AND b.assigned_provider_user_id IS NOT NULL`,
        [missionId, userId],
      );
      const bookingId = await this.db.qOne<{booking_id: string}>(
        `SELECT booking_id FROM missions WHERE id = $1`, [missionId],
      );
      // A1 SOS-WAKE-DROPPED-AT-RELAY — publish the OPAQUE wake format
      // (mirroring BookingPushBridge.publish): store the detail blob under
      // `push-event:<eventId>` and put ONLY {userId, eventClass, eventId} on the
      // wire. The legacy payload above carried no eventId, so the
      // messenger-service subscriber bailed on `!frame.eventId` and the CPO
      // panic alert never reached FCM. We inline the format (rather than inject
      // the bridge) to avoid the OpsModule↔AgentModule DI cycle.
      const bId = bookingId?.booking_id ?? '';
      for (const r of recipients) {
        try {
          const eventId = crypto.randomBytes(16).toString('base64url');
          await this.redis.client.set(
            // A2 — recipient-bound key (see BookingPushBridge.publish).
            `push-event:${r.user_id}:${eventId}`,
            JSON.stringify({kind: 'sos-cpo-alert', missionId, bookingId: bId}),
            // INFRA-8 — parity with BookingPushBridge.EVENT_TTL_SECONDS (N-27 raised it
            // to 900: messenger's FCM data TTL is ~10min, so a Dozed device could get the
            // wake AFTER a 300s blob had already expired → the SOS rendered nothing).
            'EX', 900,
          );
          await this.redis.client.publish(
            BookingPushBridge.CHANNEL,
            JSON.stringify({userId: r.user_id, eventClass: 'sos', eventId}),
          );
          // INFRA-8 — durable inbox row (N-20) so the alert survives a swiped banner or an
          // expired blob (and a Redis outage at publish time), matching the client-SOS path.
          // Fire-and-forget by NotificationsService contract.
          await this.notifications?.record(r.user_id, {
            eventClass: 'sos', kind: 'sos-cpo-alert', missionId, bookingId: bId || null,
          });
        } catch (e) {
          this.log.warn(`SOS opaque publish failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`SOS fanout failed: ${(e as Error).message}`);
    }

    return {ok: true, sos_event_id: sos.id};
  }

  /**
   * Lead-CPO mission state transitions. Mirrors the FSM in
   * `apps/auth-service/src/ops/mission-state-machine.service.ts` for the
   * AGENT actor — pickup, go-live, complete. Implemented inline here
   * rather than depending on MissionService (which would create a
   * circular module dep: OpsModule already imports AgentModule).
   *
   * Crew + lead check gates all three. Idempotent: a re-tap during a
   * network blip falls through the conditional UPDATE with rowCount=0
   * and we no-op rather than throwing — combined with the
   * IdempotencyInterceptor at the controller boundary this gives the
   * agent UI a forgiving retry surface.
   */
  async missionPickup(userId: string, missionId: string, fix?: {lat?: number; lng?: number}): Promise<{ok: true}> {
    const res = await this.flipMissionStatus(userId, missionId, 'PICKUP', ['DISPATCHED'], fix);
    // CPO-WAYPOINTS (#12) — Start fills DISPATCH/RECON/PICKUP/EN ROUTE so the
    // timeline keeps up with the status the CPO drives from the Mission tab.
    await this.settleWaypointSeqs(missionId, [1, 2, 3, 5], userId);
    return res;
  }
  async missionGoLive(userId: string, missionId: string, fix?: {lat?: number; lng?: number}): Promise<{ok: true}> {
    // Go-live leaves CHKPT 01/02 (seq 4/6) to GPS auto-marks (mission-lead.pushTelemetry).
    return this.flipMissionStatus(userId, missionId, 'LIVE', ['PICKUP'], fix);
  }
  async missionComplete(userId: string, missionId: string, fix?: {lat?: number; lng?: number}): Promise<{ok: true}> {
    // Audit H1 — align with the canonical MissionStateMachine: LIVE → COMPLETED
    // and (LM-B10) SOS → COMPLETED for the AGENT actor. The previous
    // ['LIVE','PICKUP'] allow-list let a CPO complete a mission still in
    // PICKUP (principal not yet onboard / mission not actually under way),
    // which the source-of-truth FSM forbids and which would close + pay out
    // a mission that never went live. A CPO must go-live first. An SOS that
    // de-escalated on the ground is lead-closable (stamped in end_reason)
    // instead of dead-ending until ops intervenes.
    const res = await this.flipMissionStatus(userId, missionId, 'COMPLETED', ['LIVE', 'SOS'], fix);
    // CPO-WAYPOINTS (#12) — Finish closes DROPOFF + any still-pending seqs.
    await this.settleWaypointSeqs(missionId, [1, 2, 3, 4, 5, 6, 7], userId);
    return res;
  }

  /**
   * CPO-WAYPOINTS (#12) — settle the mission_waypoints a successful FSM transition
   * implies, so the 7-step timeline FILLS as the lead CPO taps Start/Finish on the
   * Mission tab (not only via the buried lead console). Only-forward + idempotent
   * (the `state <> 'done'` guard makes a re-tap / lost-200 retry safe); best-effort
   * so a waypoint write can never block or roll back the status flip.
   */
  private async settleWaypointSeqs(missionId: string, seqs: number[], userId: string): Promise<void> {
    try {
      await this.db.q(
        `UPDATE mission_waypoints
            SET state = 'done', settled_at = COALESCE(settled_at, NOW()),
                marked_by = $3, marked_via = 'lead'
          WHERE mission_id = $1 AND seq = ANY($2::int[]) AND state <> 'done'`,
        [missionId, seqs, userId],
      );
    } catch (e) {
      this.log.warn(`settleWaypointSeqs failed for mission ${missionId}: ${(e as Error).message}`);
    }
  }

  private async flipMissionStatus(
    userId: string,
    missionId: string,
    to: 'PICKUP' | 'LIVE' | 'COMPLETED',
    allowedFrom: readonly string[],
    fix?: {lat?: number; lng?: number},
  ): Promise<{ok: true}> {
    // FSM-1 — the crew-forward pipeline (pickup / go-live / complete) now consults the
    // mission FSM. A STATIC check on the declared froms: every allowedFrom→to must be a
    // legal AGENT transition. It never throws for a legit config (all current froms are
    // legal after the reconciliation) but rejects a future illegal allowedFrom before any
    // DB write. The conditional UPDATE below is still the race-safe enforcement.
    for (const from of allowedFrom) {
      missionFsm.assert(from as MissionStatus, to, 'AGENT');
    }
    const crew = await this.db.qOne<{is_lead: boolean}>(
      `SELECT is_lead FROM mission_crew WHERE mission_id = $1 AND agent_id = $2`,
      [missionId, userId],
    );
    if (!crew) throw new NotFoundException('not_assigned_to_mission');
    if (!crew.is_lead) throw new BadRequestException('lead_only');

    // LM-C2 — deploy checks gate the START (DISPATCHED→PICKUP): the four
    // per-mission checks (dress/vehicle/equip/briefing) are seeded at crew-assign
    // but were never enforced, so a lead could roll out unchecked. Gate on the
    // LEAD's own rows; a mission with no seeded rows (legacy) passes untouched.
    // Ops can still drive the mission via its own console paths.
    if (to === 'PICKUP') {
      const pending = await this.db.qOne<{n: string}>(
        `SELECT count(*)::text AS n FROM agent_deployment_checks
          WHERE user_id = $1 AND mission_id = $2 AND state = 'pending'`,
        [userId, missionId],
      );
      if (Number(pending?.n ?? '0') > 0) {
        throw new BadRequestException('deploy_checks_incomplete');
      }
    }
    // LM-C3 — geofence WARNING (never a block): a Start far from the pickup or a
    // Finish far from the dropoff is flagged to ops for review.
    void this.warnIfFarFromMissionPoint(userId, missionId, to === 'COMPLETED' ? 'dropoff' : 'pickup', to, fix)
      .catch(() => undefined);

    const inList = allowedFrom.map((_, i) => `$${i + 3}`).join(',');
    const params: unknown[] = [missionId, to, ...allowedFrom];
    if (to === 'COMPLETED') {
      await this.completeMissionCore(missionId, userId, 'CPO', allowedFrom);
    } else {
      // Stamp the per-state timestamp the proof gate reads (additive; the
      // conditional WHERE means it fires exactly once on the valid transition).
      const stamp = to === 'PICKUP' ? ', pickup_at = NOW()' : ', live_at = NOW()';
      const upd = await this.db.q(
        `UPDATE missions SET status = $2, updated_at = NOW()${stamp}
          WHERE id = $1 AND status IN (${inList})
          RETURNING booking_id`,
        params,
      );
      // Why: an AUTO-dispatch booking stays CONFIRMED while the mission runs. When the lead
      // takes the mission LIVE, advance the booking CONFIRMED→LIVE too so (a) the client's
      // live-tracking activates and (b) the LIVE→COMPLETED flip on Finish (which is guarded
      // on booking status='LIVE') is reachable. The FSM trigger permits CONFIRMED→LIVE; a
      // legacy booking that ops already flipped to LIVE is a guarded no-op.
      if (upd.length > 0) {
        const bId = (upd[0] as {booking_id: string}).booking_id;
        // CLIENT-PICKED-UP (founder deck, Aug 2026): the checkpoint must record
        // "mission ID, user/driver ID, GPS position, timestamp". The device fix
        // that rides with the request was previously used ONLY for the transient
        // geofence warning and then discarded, so after the fact there was no way
        // to answer "where was the driver when they confirmed pickup".
        //
        // Written only when the conditional UPDATE actually matched, so a replayed
        // idempotent 200 cannot fabricate a second record. Best-effort by design:
        // these actions are deliberately NOT in OpsAuditService.CRITICAL_ACTIONS,
        // because a transient insert failure must never roll back a real mission
        // transition. created_at is the authoritative timestamp.
        const hasFix = typeof fix?.lat === 'number' && typeof fix?.lng === 'number';
        void this.db.q(
          `INSERT INTO ops_audit
             (actor_id, actor_role, action, subject_type, subject_id, metadata)
           VALUES ($1, 'AGENT', $2, 'mission', $3, $4::jsonb)`,
          [
            userId,
            to === 'PICKUP' ? 'mission.arrived_at_pickup' : 'mission.client_picked_up',
            missionId,
            JSON.stringify({
              booking_id: bId ?? null,
              lat: hasFix ? fix?.lat : null,
              lng: hasFix ? fix?.lng : null,
              // A denied permission or a timeout resolves the fix to undefined —
              // record that honestly rather than implying an unknown position.
              has_fix: hasFix,
              source: 'lead_confirmation',
            }),
          ],
        ).catch(() => undefined);
        if (to === 'LIVE' && bId) {
          const flipped = await this.db.q(
            `UPDATE lite_bookings SET status = 'LIVE' WHERE id = $1 AND status = 'CONFIRMED' RETURNING id`,
            [bId],
          );
          if (flipped.length > 0) {
            // LM-V6 — audit the CPO-driven go-live for the timeline.
            await this.db.q(
              `INSERT INTO lite_booking_audit (booking_id, from_status, to_status, actor_id, actor_role, metadata)
               VALUES ($1, 'CONFIRMED', 'LIVE', $2, 'CPO', $3::jsonb)`,
              [bId, userId, JSON.stringify({reason: 'lead_go_live', mission_id: missionId})],
            ).catch(() => undefined);
          }
        }
        // LM-B3 — realtime frame on the button path (parity with the
        // waypoint/telemetry path, which already emits these).
        if (bId) {
          void this.events?.statusChanged(missionId, to, bId);
          // LM-N4 — the mission-progress steps (en route / protection active) were
          // previously SILENT to the client. Push them so a backgrounded/killed app
          // gets a banner + a deep-link into the live tracker for every step.
          if (to === 'PICKUP' || to === 'LIVE') {
            void (async () => {
              const owner = await this.db.qOne<{client_id: string}>(
                `SELECT client_id FROM lite_bookings WHERE id = $1`, [bId],
              );
              if (!owner?.client_id) {return;}
              if (to === 'PICKUP') {await this.bookingPush?.missionEnRoute(owner.client_id, bId);}
              else {await this.bookingPush?.missionLive(owner.client_id, bId);}
            })().catch(() => undefined);
          }
        }
      }
    }
    return {ok: true};
  }

  /**
   * Audit C1 — the shared mission-completion core (extracted for LM-C7 so the
   * AGENCY confirm path reuses the exact same money-safe flow as the lead's
   * Finish). Flips mission → COMPLETED (+ crew off + booking flip + audit) in
   * one txn, then settles: escrow bookings run the proof gate → PENDING_RELEASE
   * / review_required (NEVER paid inline); legacy bookings keep the idempotent
   * even-split payout. Every write is idempotent, so ops completing later
   * cannot double-pay.
   */
  private async completeMissionCore(
    missionId: string,
    actorUserId: string,
    actorRole: 'CPO' | 'ORG',
    allowedFrom: readonly string[],
  ): Promise<{completed: boolean}> {
    const inList = allowedFrom.map((_, i) => `$${i + 2}`).join(',');
    const bookingId = await this.db.withTransaction(async tx => {
      // LM-B10 — a close from SOS records why in end_reason (`status` in the SET
      // expression reads the OLD row value).
      const upd = await tx.q(
        // FSM-2 — a mission must have gone LIVE to complete. This blocks the
        // DISPATCHED->SOS->COMPLETED bypass (SOS is reachable from DISPATCHED, and
        // COMPLETED is allowed from SOS), which would otherwise terminally close a
        // booking around a mission that never actually happened. live_at is set at
        // go-live and never cleared, so every legitimate completion satisfies it.
        `UPDATE missions SET status = 'COMPLETED', updated_at = NOW(), ended_at = NOW(),
                end_reason = CASE WHEN status = 'SOS'
                                  THEN COALESCE(end_reason, 'sos_closed_by_lead')
                                  ELSE end_reason END
          WHERE id = $1 AND status IN (${inList}) AND live_at IS NOT NULL
          RETURNING id, booking_id`,
        [missionId, ...allowedFrom],
      );
      if (upd.length === 0) return null; // already completed by another writer
      const bId = (upd[0] as {booking_id: string}).booking_id;
      // Release the crew so mission_crew_agent_active_uq frees each CPO for
      // their next mission (the no-show + abort paths release the same way).
      await tx.q(`UPDATE mission_crew SET status = 'off' WHERE mission_id = $1`, [missionId]);
      if (bId) {
        // MISSION-COMPLETE booking flip — must accept CONFIRMED, not just LIVE
        // (auto bookings can sit CONFIRMED for the whole mission).
        const flipped = await tx.q(
          `UPDATE lite_bookings SET status = 'COMPLETED'
            WHERE id = $1 AND status IN ('LIVE','CONFIRMED') RETURNING id`,
          [bId],
        );
        if (flipped.length > 0) {
          // LM-V6 — timeline audit. Fail-closed inside the txn.
          await tx.q(
            `INSERT INTO lite_booking_audit (booking_id, from_status, to_status, actor_id, actor_role, metadata)
             VALUES ($1, NULL, 'COMPLETED', $2, $3, $4::jsonb)`,
            [bId, actorUserId, actorRole === 'ORG' ? 'OPS_HANDLER' : 'CPO',
             JSON.stringify({reason: actorRole === 'ORG' ? 'org_confirm_finish' : 'lead_finish', mission_id: missionId})],
          );
        }
      }
      return bId ?? null;
    });
    if (!bookingId) {
      return {completed: false};
    }
    // LM-B3 — realtime frame so the client/agency see COMPLETED instantly.
    void this.events?.statusChanged(missionId, 'COMPLETED', bookingId);
    // The Ops Room is MISSION-scoped: once the mission is over it must drop off
    // the chat list of ALL three parties (agency, client, CPO). B-207 — the
    // founder directed a HARD DELETE (not archive): the whole group is removed
    // for everyone on completion. listMine stops returning the row, and
    // MessengerHomeScreen's server-reconciliation sweep then prunes the local
    // copy on each device (and evicts its group key). This supersedes the B-191
    // archive design.
    //
    // Why here and not only in settlement: settleEscrowRelease runs ~3 days
    // later (disputeWindowSeconds), is gated on AUTO_DISPATCH_ENABLED, and never
    // runs at all once `review_required` is set — so the room outlived the
    // mission indefinitely in exactly the cases users hit. This is the handler
    // the CPO's "Finish" and the agency's LM-C7 confirm both funnel through.
    //
    // Same six-statement primitive as SystemMessengerService.deleteMissionRoom,
    // but INLINED: OpsModule imports AgentModule, so AgentService cannot inject
    // the OpsModule-provided SystemMessengerService without a DI cycle (see the
    // constructor's MissionEventsService/BookingPushBridge note). Deleting the
    // intents is load-bearing — a leftover pending add-intent would make a later
    // agency drain re-mint a ghost room. Server metadata only — no key material,
    // no epoch, no rekey. Best-effort + idempotent, deliberately OUTSIDE the
    // money txn (a chat-teardown failure must never roll back a completion).
    try {
      await this.db.withTransaction(async tx => {
        const mrow = await tx.qOne<{comms_channel_id: string | null}>(
          `SELECT comms_channel_id FROM missions WHERE id = $1`, [missionId]);
        const convId = mrow?.comms_channel_id;
        if (!convId) {return;}
        const c = [convId];
        await tx.q(`UPDATE public.lite_bookings SET conversation_id = NULL WHERE conversation_id = $1`, c);
        await tx.q(`UPDATE public.missions SET comms_channel_id = NULL WHERE comms_channel_id = $1`, c);
        await tx.q(`DELETE FROM public.dispatch_room_intents WHERE conversation_id = $1`, c);
        await tx.q(`DELETE FROM public.conversation_members WHERE conversation_id = $1`, c);
        await tx.q(`DELETE FROM public.system_broadcasts WHERE conversation_id = $1`, c);
        await tx.q(`DELETE FROM public.conversations WHERE id = $1`, c);
      });
    } catch (e) {
      this.log.warn(`ops-room delete failed for mission ${missionId}: ${(e as Error).message}`);
    }
    // Settle OUTSIDE the flip txn. Escrow bookings defer through the proof gate;
    // legacy bookings keep the idempotent even-split.
    const hold = await this.db.qOne<{booking_id: string}>(
      `SELECT booking_id FROM escrow_holds WHERE booking_id = $1 AND status = 'HELD'`,
      [bookingId],
    );
    if (hold) {
      await this.settleEscrowOnFinish(bookingId, missionId);
    } else {
      await this.disburseMissionPayout(missionId, bookingId, actorUserId);
    }
    // LM-N4 — completion wake to the CLIENT ("rate & receipt").
    const owner = await this.db.qOne<{client_id: string}>(
      `SELECT client_id FROM lite_bookings WHERE id = $1`,
      [bookingId],
    );
    if (owner) {
      void this.bookingPush?.bookingCompleted(owner.client_id, bookingId).catch(() => undefined);
    }
    return {completed: true};
  }

  /**
   * LM-C7 — the AGENCY confirms completion when the lead can't (phone died,
   * crew requested it). Org-scoped (the mission's booking must be assigned to
   * this org) and runs the SAME money-safe completion core as the lead Finish
   * (proof gate + release sweep still stand — the agency cannot pay itself
   * early by confirming).
   */
  async completeMissionAsOrg(orgUserId: string, missionId: string): Promise<{ok: true; completed: boolean}> {
    const owned = await this.db.qOne<{id: string}>(
      `SELECT m.id FROM missions m
         JOIN lite_bookings b ON b.id = m.booking_id
        WHERE m.id = $1 AND b.assigned_provider_user_id = $2`,
      [missionId, orgUserId],
    );
    if (!owned) throw new NotFoundException('mission_not_found');
    const res = await this.completeMissionCore(missionId, orgUserId, 'ORG', ['LIVE', 'SOS']);
    if (!res.completed) throw new BadRequestException('mission_not_completable');
    return {ok: true, completed: true};
  }

  /** LM-C2 — a crew member self-acknowledges one of their deploy checks
   *  (dress/vehicle/equip/briefing). Ops sign-off can still override. */
  async acknowledgeDeployCheck(userId: string, missionId: string, checkKey: string): Promise<{ok: true}> {
    const member = await this.db.qOne<{mission_id: string}>(
      `SELECT mission_id FROM mission_crew WHERE mission_id = $1 AND agent_id = $2`,
      [missionId, userId],
    );
    if (!member) throw new NotFoundException('not_assigned_to_mission');
    const upd = await this.db.q(
      `UPDATE agent_deployment_checks
          SET state = 'passed', signed_by = $1, signed_at = NOW()
        WHERE user_id = $1 AND mission_id = $2 AND check_key = $3 AND state = 'pending'
        RETURNING check_key`,
      [userId, missionId, checkKey],
    );
    if (upd.length === 0) {
      // Unknown key or already settled — idempotent for a re-tap, 404 for junk.
      const exists = await this.db.qOne<{check_key: string}>(
        `SELECT check_key FROM agent_deployment_checks
          WHERE user_id = $1 AND mission_id = $2 AND check_key = $3`,
        [userId, missionId, checkKey],
      );
      if (!exists) throw new NotFoundException('check_not_found');
    }
    return {ok: true};
  }

  /** LM-C4 — any crew member (not just the lead) marks themselves in position.
   *  Surfaces on the agency monitor + deployment payload. Idempotent. */
  async crewCheckIn(userId: string, missionId: string): Promise<{ok: true; checked_in_at: string}> {
    const row = await this.db.qOne<{checked_in_at: Date}>(
      `UPDATE mission_crew
          SET checked_in_at = COALESCE(checked_in_at, NOW())
        WHERE mission_id = $1 AND agent_id = $2
        RETURNING checked_in_at`,
      [missionId, userId],
    );
    if (!row) throw new NotFoundException('not_assigned_to_mission');
    return {ok: true, checked_in_at: row.checked_in_at.toISOString()};
  }

  /**
   * Executive Protection — the LEAD confirms each elapsed hour of the protection block
   * ("everything is going smooth" + optional comment). Replaces the waypoint
   * timeline executive missions don't have.
   *
   * Rules: lead-only · executive bookings only · mission LIVE or SOS · hour_index
   * within 1..duration_hours · an hour is confirmable only once it has
   * ELAPSED (live_at + hour_index hours, minus a 2-minute grace so a tap at
   * 59:58 isn't rejected) · idempotent (UNIQUE(mission_id, hour_index) —
   * a re-tap returns the existing row). Fans out to the client (their
   * hour-by-hour timeline) and the agency managers.
   */
  async hourlyCheckIn(
    userId: string, missionId: string, hourIndex: number, comment?: string,
  ): Promise<{ok: true; hour_index: number; status: string; created_at: string}> {
    const hi = Math.trunc(Number(hourIndex));
    if (!Number.isFinite(hi) || hi < 1 || hi > 24) {
      throw new BadRequestException('invalid_hour_index');
    }
    const trimmed = (comment ?? '').trim().slice(0, 300) || null;

    const ctx = await this.db.qOne<{
      booking_id: string; mission_status: string; live_at: Date | null;
      service: string; duration_hours: number; client_id: string;
      provider: string | null; is_lead: boolean; short_code: string;
    }>(
      `SELECT m.booking_id, m.status AS mission_status, m.live_at, m.short_code,
              b.service, b.duration_hours, b.client_id,
              b.assigned_provider_user_id AS provider, mc.is_lead
         FROM mission_crew mc
         JOIN missions m ON m.id = mc.mission_id
         JOIN lite_bookings b ON b.id = m.booking_id
        WHERE mc.mission_id = $1 AND mc.agent_id = $2 AND mc.status <> 'off'`,
      [missionId, userId],
    );
    if (!ctx) throw new NotFoundException('not_assigned_to_mission');
    if (!ctx.is_lead) throw new ForbiddenException('lead_only');
    if (ctx.service !== 'executive_protection') throw new BadRequestException('not_an_executive_mission');
    if (ctx.mission_status !== 'LIVE' && ctx.mission_status !== 'SOS') {
      throw new BadRequestException('mission_not_live');
    }
    if (hi > ctx.duration_hours) {
      throw new BadRequestException('hour_beyond_duration');
    }
    if (!ctx.live_at) throw new BadRequestException('mission_not_live');
    const dueAt = new Date(ctx.live_at).getTime() + hi * 3600_000 - 120_000;
    if (Date.now() < dueAt) {
      throw new BadRequestException({
        code: 'hour_not_elapsed',
        message: `Hour ${hi} can be confirmed from ${new Date(dueAt + 120_000).toISOString()}.`,
        due_at: new Date(dueAt + 120_000).toISOString(),
      });
    }

    // Idempotent: the unique (mission_id, hour_index) makes a re-tap adopt
    // the existing row instead of erroring or duplicating.
    const inserted = await this.db.qOne<{hour_index: number; status: string; comment: string | null; created_at: Date}>(
      `INSERT INTO mission_hourly_checkins (mission_id, booking_id, hour_index, status, comment, created_by)
       VALUES ($1, $2, $3, 'SMOOTH', $4, $5)
       ON CONFLICT (mission_id, hour_index) DO NOTHING
       RETURNING hour_index, status, comment, created_at`,
      [missionId, ctx.booking_id, hi, trimmed, userId],
    );
    const row = inserted ?? await this.db.qOne<{hour_index: number; status: string; comment: string | null; created_at: Date}>(
      `SELECT hour_index, status, comment, created_at
         FROM mission_hourly_checkins WHERE mission_id = $1 AND hour_index = $2`,
      [missionId, hi],
    );
    if (!row) throw new BadRequestException('checkin_failed');

    // Fresh insert → notify client + agency (a re-tap must not re-push).
    if (inserted) {
      await this.bookingPush?.hourlyCheckin(ctx.client_id, ctx.booking_id, hi);
      if (ctx.provider) {
        await this.bookingPush?.hourlyCheckinAgency(ctx.provider, ctx.booking_id, missionId, hi);
      }
    }

    return {
      ok: true,
      hour_index: row.hour_index,
      status: row.status,
      created_at: row.created_at?.toISOString?.() ?? String(row.created_at),
    };
  }

  /**
   * LM-C7 — a crew member asks the agency to close the mission (lead
   * unreachable / phone died). Wakes the org manager, who confirms via
   * POST /org/missions/:id/complete. Rate-limited by idempotence of the wake
   * TTL — repeat taps are harmless.
   */
  async requestComplete(userId: string, missionId: string): Promise<{ok: true}> {
    const ctx = await this.db.qOne<{booking_id: string; provider: string | null; status: string}>(
      `SELECT m.booking_id, b.assigned_provider_user_id AS provider, m.status
         FROM mission_crew mc
         JOIN missions m ON m.id = mc.mission_id
         JOIN lite_bookings b ON b.id = m.booking_id
        WHERE mc.mission_id = $1 AND mc.agent_id = $2`,
      [missionId, userId],
    );
    if (!ctx) throw new NotFoundException('not_assigned_to_mission');
    if (ctx.status !== 'LIVE' && ctx.status !== 'SOS') {
      throw new BadRequestException('mission_not_live');
    }
    if (ctx.provider) {
      void this.bookingPush?.missionCompleteRequested(ctx.provider, missionId, ctx.booking_id)
        .catch(() => undefined);
    }
    try {
      await this.db.q(
        `INSERT INTO ops_audit (actor_role, actor_id, action, subject_type, subject_id, metadata)
         VALUES ('AGENT', $1, 'mission.complete_requested', 'mission', $2, $3::jsonb)`,
        [userId, missionId, JSON.stringify({booking_id: ctx.booking_id})],
      );
    } catch (e) {
      this.log.warn(`requestComplete audit failed: ${(e as Error).message}`);
    }
    return {ok: true};
  }

  /** LM-C3 — non-blocking geofence check: warn ops when a transition fires far
   *  from the relevant mission point. 500m default radius. */
  private async warnIfFarFromMissionPoint(
    userId: string, missionId: string, point: 'pickup' | 'dropoff',
    transition: string, fix?: {lat?: number; lng?: number},
  ): Promise<void> {
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) {return;}
    const b = await this.db.qOne<{p_lat: string | null; p_lng: string | null}>(
      point === 'pickup'
        ? `SELECT b.pickup_lat AS p_lat, b.pickup_lng AS p_lng
             FROM missions m JOIN lite_bookings b ON b.id = m.booking_id WHERE m.id = $1`
        : `SELECT COALESCE(b.dropoff_lat, b.pickup_lat) AS p_lat, COALESCE(b.dropoff_lng, b.pickup_lng) AS p_lng
             FROM missions m JOIN lite_bookings b ON b.id = m.booking_id WHERE m.id = $1`,
      [missionId],
    );
    if (!b || b.p_lat === null || b.p_lng === null) {return;}
    const dist = haversineMeters(fix.lat as number, fix.lng as number, Number(b.p_lat), Number(b.p_lng));
    const radius = this.config.get<number>('dispatch.transitionGeofenceM') ?? 500;
    if (dist <= radius) {return;}
    this.log.warn(`[geofence] mission=${missionId} ${transition} fired ${Math.round(dist)}m from ${point} by ${userId}`);
    await this.db.q(
      `INSERT INTO ops_audit (actor_role, actor_id, action, subject_type, subject_id, metadata)
       VALUES ('AGENT', $1, 'mission.geofence_warn', 'mission', $2, $3::jsonb)`,
      [userId, missionId, JSON.stringify({transition, point, distance_m: Math.round(dist)})],
    ).catch(() => undefined);
  }

  /**
   * Step 16 — the assigned LEAD reads the on-arrival verify code for their mission's
   * booking. Derived (shared deriveVerifyCode) from booking_id + the lead's own agent
   * id, so it MATCHES the value the client reads from GET /bookings/:id/verify-code.
   * Lead-only: a non-lead crew member or non-member is rejected, which is what makes
   * the handshake meaningful — only the dispatched lead can produce the matching code.
   */
  async getMissionVerifyCode(userId: string, missionId: string): Promise<{code: string; rotates_at: string}> {
    const row = await this.db.qOne<{is_lead: boolean; booking_id: string}>(
      `SELECT mc.is_lead, m.booking_id
         FROM mission_crew mc JOIN missions m ON m.id = mc.mission_id
        WHERE mc.mission_id = $1 AND mc.agent_id = $2`,
      [missionId, userId],
    );
    if (!row) throw new NotFoundException('not_assigned_to_mission');
    if (!row.is_lead) throw new BadRequestException('lead_only');
    const secret = this.config.get<string>('jwt.actionSecret') ?? '';
    return deriveVerifyCode(secret, row.booking_id, userId, Date.now());
  }

  /**
   * FRAUD-2 / P0 — the assigned LEAD proves physical presence by entering the
   * arrival code the CLIENT's screen displays. That code is bound to the CLIENT's
   * id (deriveVerifyCode(secret, bookingId, client_id, …)), NOT the lead's, so the
   * lead's own verify-code endpoint yields a DIFFERENT value and cannot self-derive
   * it — a match therefore requires the lead to have seen the principal's screen.
   * On a match we stamp missions.identity_verified_at, which proof-of-completion
   * check 5 requires (when requireIdentityHandshake is on) before escrow may
   * auto-release. Idempotent: a re-submit after a successful verify is a no-op.
   * The submitted code is NEVER logged (it is a rotating credential).
   */
  async verifyArrival(userId: string, missionId: string, code: string): Promise<{verified: boolean; rotates_at: string}> {
    const row = await this.db.qOne<{is_lead: boolean; booking_id: string; client_id: string; identity_verified_at: Date | null}>(
      `SELECT mc.is_lead, m.booking_id, m.identity_verified_at, b.client_id
         FROM mission_crew mc
         JOIN missions m       ON m.id = mc.mission_id
         JOIN lite_bookings b  ON b.id = m.booking_id
        WHERE mc.mission_id = $1 AND mc.agent_id = $2`,
      [missionId, userId],
    );
    if (!row) throw new NotFoundException('not_assigned_to_mission');
    if (!row.is_lead) throw new BadRequestException('lead_only');
    const secret = this.config.get<string>('jwt.actionSecret') ?? '';
    const now = Date.now();
    if (row.identity_verified_at) {
      // Already verified — idempotent success, no re-check.
      return {verified: true, rotates_at: deriveVerifyCode(secret, row.booking_id, row.client_id, now).rotates_at};
    }
    const submitted = String(code ?? '').trim();
    // Accept the current OR previous window so a read/submit straddling a rotation
    // still verifies. Constant-time compare on equal-length 6-digit strings.
    const candidates = [
      deriveVerifyCode(secret, row.booking_id, row.client_id, now),
      deriveVerifyCode(secret, row.booking_id, row.client_id, now - VERIFY_CODE_WINDOW_MS),
    ];
    const match = candidates.some(c =>
      c.code.length === submitted.length &&
      crypto.timingSafeEqual(Buffer.from(c.code), Buffer.from(submitted)),
    );
    if (!match) throw new BadRequestException('verify_code_mismatch');
    await this.db.q(
      `UPDATE missions
          SET identity_verified_at = NOW(), identity_verified_by = $2, updated_at = NOW()
        WHERE id = $1 AND identity_verified_at IS NULL`,
      [missionId, userId],
    );
    // Audit trail — who proved presence, on which booking, and when. The SUBMITTED
    // code is a rotating credential and is NEVER recorded (only the fact of a match).
    await this.db.q(
      `INSERT INTO ops_audit (actor_role, actor_id, action, subject_type, subject_id, metadata)
       VALUES ('AGENT', $1, 'mission.identity_verified', 'mission', $2, $3::jsonb)`,
      [userId, missionId, JSON.stringify({booking_id: row.booking_id})],
    ).catch(() => undefined);
    return {verified: true, rotates_at: candidates[0].rotates_at};
  }

  /**
   * Step 10 — lead Finish on an AUTO-dispatch (escrow-held) booking moves NO money
   * (LB4). Run the server-side proof-of-completion gate: PASS opens the hold to
   * PENDING_RELEASE with a dispute window (the Step 11 sweep does the actual
   * escrow->CPO release after it elapses); FAIL flags review_required so it never
   * auto-releases. Both transitions are guarded on status='HELD' so a re-tap is a
   * no-op. (TODO: trust-tier the dispute window from rating/jobs_total/breaches —
   * the config default is a safe long window until then.)
   */
  private async settleEscrowOnFinish(bookingId: string, missionId: string): Promise<void> {
    // B-76 (2026-07-11) — this runs OUTSIDE the completion txn, AFTER the mission
    // is already COMPLETED (committed in completeMissionCore). Before, a throw here
    // (proof-gate PostGIS error, escrow_holds UPDATE failure) surfaced to the CPO as
    // a 500 for a Finish that actually landed — "sometimes cannot finish (API error)"
    // — and the escrow stayed HELD. Best-effort so the CPO's completed action reports
    // honestly; both writes are idempotent (guarded on status='HELD') so a later
    // re-settle is safe. A failure strands the hold HELD with no auto-retry sweep
    // (EscrowReconciliationService is read-only), so log LOUD (error, greppable, with
    // the booking id) for operator repair via the §41 dispute/resolve path.
    try {
      const gate = await this.proof.runProofGate(bookingId, missionId);
      if (gate.pass) {
        const windowSec = this.config.get<number>('dispatch.disputeWindowSeconds') ?? 259200;
        await this.db.q(
          `UPDATE escrow_holds
              SET status = 'PENDING_RELEASE', completed_at = NOW(),
                  release_eligible_at = NOW() + ($2 || ' seconds')::interval
            WHERE booking_id = $1 AND status = 'HELD'`,
          [bookingId, windowSec],
        );
      } else {
        await this.db.q(
          `UPDATE escrow_holds SET review_required = TRUE, completed_at = NOW()
            WHERE booking_id = $1 AND status = 'HELD'`,
          [bookingId],
        );
      }
    } catch (e) {
      this.log.error(
        `settleEscrowOnFinish FAILED (escrow stranded HELD — needs operator settle) ` +
        `booking=${bookingId} mission=${missionId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Audit C1 — idempotent escrow even-split payout for an agent-completed
   * mission. Deliberately the SIMPLE even-split (no deduction overrides);
   * ops retains the rich deduction/override flow via its own completeBooking
   * on a still-LIVE booking. Every write here is idempotent:
   *   • wallet.creditForBooking → ux_wallet_tx_payout (per user+booking)
   *   • mission_payouts insert  → ux_mission_payouts_unique (ON CONFLICT)
   * so this can run alongside (before/after) an ops completion without ever
   * double-crediting. Best-effort per agent: one agent's failure is logged,
   * not fatal, and a later ops completeBooking reconciles the remainder.
   */
  private async disburseMissionPayout(
    missionId: string, bookingId: string, completedBy: string,
  ): Promise<void> {
    try {
      const booking = await this.db.qOne<{total_eur: string; short_code: string | null}>(
        `SELECT b.total_eur, m.short_code
           FROM lite_bookings b JOIN missions m ON m.id = $2
          WHERE b.id = $1`,
        [bookingId, missionId],
      );
      if (!booking) return;
      const escrow = Math.round(Number(booking.total_eur));
      if (escrow <= 0) return;
      // Phase 2 — pay the real OFFICERS (mission_crew), each credited to their
      // PAYEE (org for managed CPOs, else self). Was: cpoAssign.getForBooking,
      // which returned cpo_pool.id (not a real user) and silently no-op-credited
      // phantom ids. Aggregate per payee before crediting because
      // creditForBooking dedupes on (user_id, booking_id).
      const crew = await this.cpoAssign.getCrewForPayout(bookingId);
      if (crew.length === 0) return;
      const evenSplit = Math.floor(escrow / crew.length);
      if (evenSplit <= 0) return;
      const missionRef = booking.short_code ?? `BL-${bookingId.replace(/-/g, '').slice(-8).toUpperCase()}`;

      const resolved = await Promise.all(crew.map(async c => ({
        officerId: c.user_id,
        call_sign: c.call_sign,
        payeeId: await this.cpoAssign.resolvePayeeUserId(bookingId, c.user_id),
      })));
      const payeeTotals = new Map<string, number>();
      for (const r of resolved) payeeTotals.set(r.payeeId, (payeeTotals.get(r.payeeId) ?? 0) + evenSplit);

      for (const [payeeId, sum] of payeeTotals) {
        try {
          await this.wallet.creditForBooking(payeeId, bookingId, sum, `Mission payout · ${missionRef}`);
        } catch (e) {
          this.log.warn(`agent-complete credit failed for payee ${payeeId} on ${bookingId}: ${(e as Error).message}`);
        }
      }
      for (const r of resolved) {
        try {
          await this.db.q(
            `INSERT INTO mission_payouts
               (mission_id, booking_id, agent_user_id, payee_user_id, call_sign,
                proposed_credits, paid_credits, deduction_credits, deduction_reason, decided_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,0,NULL,$8)
             ON CONFLICT (mission_id, agent_user_id) DO NOTHING`,
            [missionId, bookingId, r.officerId, r.payeeId, r.call_sign, evenSplit, evenSplit, completedBy],
          );
        } catch (e) {
          this.log.warn(`agent-complete audit failed for ${r.officerId} on ${bookingId}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`agent-complete disburse failed for ${bookingId}: ${(e as Error).message}`);
    }
  }

  async acknowledgeDress(userId: string, missionId: string): Promise<{ok: true; acknowledged_at: string}> {
    const row = await this.db.qOne<{mission_id: string}>(
      `SELECT mission_id FROM mission_crew WHERE mission_id = $1 AND agent_id = $2`,
      [missionId, userId],
    );
    if (!row) throw new NotFoundException('not_assigned_to_mission');
    const updated = await this.db.qOne<{dress_acknowledged_at: Date}>(
      `UPDATE mission_crew
          SET dress_acknowledged_at = COALESCE(dress_acknowledged_at, NOW())
        WHERE mission_id = $1 AND agent_id = $2
        RETURNING dress_acknowledged_at`,
      [missionId, userId],
    );
    return {ok: true, acknowledged_at: (updated?.dress_acknowledged_at ?? new Date()).toISOString()};
  }

  // ─── 07 · Admin review ────────────────────────────────────────

  async startReview(userId: string, adminId: string): Promise<void> {
    const agent = await this.requireAgent(userId);
    this.fsm.assert(agent.status, 'UNDER_REVIEW', 'ADMIN');
    await this.db.q(`UPDATE agents SET status = 'UNDER_REVIEW' WHERE user_id = $1`, [userId]);
    await this.db.q(
      `UPDATE agent_review_pipeline SET state = 'in_progress'
        WHERE user_id = $1 AND step IN ('docs','kyc','ops','partner') AND state = 'pending'`,
      [userId],
    );
    await this.audit(userId, agent.status, 'UNDER_REVIEW', adminId, 'ADMIN', {reason: 'review_opened'});
  }

  async decide(
    userId: string,
    adminId: string,
    decision: 'APPROVED' | 'REJECTED',
    notes?: string,
  ): Promise<void> {
    // Atomic FSM-respecting decision. The previous version skipped the
    // intermediate APPROVED state and wrote ACTIVE directly with no
    // `WHERE status = $expected` guard. Two effects of the rewrite:
    //   1. The agent row is moved via two CONDITIONAL UPDATEs — a
    //      concurrent admin clicking decide() in parallel sees the
    //      second UPDATE's rowCount=0 and we throw, rather than both
    //      blindly stomping the status.
    //   2. The audit ledger now records UNDER_REVIEW→APPROVED followed by
    //      APPROVED→ACTIVE, matching the FSM table. Forensics stays
    //      consistent with the assertion at line 905.
    const agentType = await this.db.withTransaction(async tx => {
      const agent = await tx.qOne<AgentRow>(
        `SELECT * FROM agents WHERE user_id = $1 FOR UPDATE`, [userId],
      );
      if (!agent) throw new NotFoundException('Agent not found');
      this.fsm.assert(agent.status, decision, 'ADMIN');

      if (decision === 'REJECTED') {
        const upd = await tx.q(
          `UPDATE agents SET status = 'REJECTED'
            WHERE user_id = $1 AND status = $2 RETURNING user_id`,
          [userId, agent.status],
        );
        if (upd.length === 0) {
          throw new BadRequestException('agent_state_changed_concurrently');
        }
      } else {
        // APPROVED — write the intermediate state first so audit + FSM line up.
        const u1 = await tx.q(
          `UPDATE agents SET status = 'APPROVED', approved_at = NOW()
            WHERE user_id = $1 AND status = $2 RETURNING user_id`,
          [userId, agent.status],
        );
        if (u1.length === 0) {
          throw new BadRequestException('agent_state_changed_concurrently');
        }
        // Then move APPROVED → ACTIVE as the SYSTEM transition the FSM
        // table allows (state-machine.service.ts:55-58).
        this.fsm.assert('APPROVED', 'ACTIVE', 'SYSTEM');
        const u2 = await tx.q(
          `UPDATE agents SET status = 'ACTIVE', activated_at = NOW()
            WHERE user_id = $1 AND status = 'APPROVED' RETURNING user_id`,
          [userId],
        );
        if (u2.length === 0) {
          throw new BadRequestException('agent_state_changed_concurrently');
        }
      }
      // Mark all intermediate steps done so the mobile pipeline shows full progress.
      await tx.q(
        `UPDATE agent_review_pipeline
            SET state = 'done', settled_at = NOW(), reviewer_id = $2
          WHERE user_id = $1 AND step IN ('submit','docs','kyc','ops') AND state <> 'done'`,
        [userId, adminId],
      );
      await tx.q(
        `UPDATE agent_review_pipeline
            SET state = $3, settled_at = NOW(), notes = $4, reviewer_id = $2
          WHERE user_id = $1 AND step = 'partner'`,
        [userId, adminId, decision === 'APPROVED' ? 'done' : 'rejected', notes ?? null],
      );
      // Audit both transitions for APPROVED so the timeline reflects the FSM.
      if (decision === 'APPROVED') {
        // B-24 — MUST ride the tx connection (see audit() doc-comment).
        await this.audit(userId, agent.status, 'APPROVED', adminId, 'ADMIN', {notes}, tx);
        await this.audit(userId, 'APPROVED', 'ACTIVE', adminId, 'SYSTEM', {reason: 'auto_activate'}, tx);
      } else {
        await this.audit(userId, agent.status, 'REJECTED', adminId, 'ADMIN', {notes}, tx);
      }
      return agent.type;
    });

    // Phase 3 — when a SERVICE-PROVIDER org (company agent) is approved, seed
    // its default chat workspace. Post-commit + best-effort: a seeding hiccup
    // must not roll back the approval. Idempotent (skips if channels exist).
    if (decision === 'APPROVED' && agentType === 'company') {
      try {
        await this.department.seedOrgWorkspace(userId);
      } catch (e) {
        this.log.warn(`seedOrgWorkspace failed for org ${userId}: ${(e as Error).message}`);
      }
    }
  }

  // ─── 08 · Dashboard ───────────────────────────────────────────

  /**
   * Bug 3 — stamp the agency's dispatch region + DPA acceptance: the two
   * is_eligible_for_dispatch / ranker inputs that no other screen writes.
   * Company agents only. region_code must be a supported region; DPA is
   * fail-closed (only a literal `true` stamps the timestamp), and COALESCE
   * keeps the first acceptance time so re-saving the region never resets the
   * legal consent record. No side effects (does NOT flip on_duty or dispatch).
   */
  async setAgencyProfile(
    userId: string,
    dto: {region_code: string; dpa_accepted: boolean; dpa_version?: string},
  ): Promise<{region_code: string | null; dpa_accepted_at: string | null}> {
    // The region + DPA are ORG-level settings, but this endpoint writes the
    // CALLER's own `agents` row. A promoted manager is minted as a managed CPO
    // (`agents.type='cpo'`) and promotion only flips `org_members.member_role`,
    // yet `resolveAuthedRoute` sends them into the OWNER's shell where the
    // Region tile is unconditionally visible — so every manager who tapped Save
    // got a bare 400 `agency_profile_is_company_only` with no way to succeed.
    //
    // Resolve the org the caller actually administers and write THAT row: the
    // company account itself, or the org an active manager belongs to. Anyone
    // else still 400s.
    let targetUserId = userId;
    const agent = await this.requireAgent(userId);
    if (agent.type !== 'company') {
      const managed = await this.db.qOne<{org_user_id: string}>(
        `SELECT om.org_user_id
           FROM org_members om
           JOIN agents a ON a.user_id = om.org_user_id AND a.type = 'company'
          WHERE om.member_user_id = $1 AND om.status = 'active' AND om.member_role = 'manager'
          -- vs2 item 4: deterministic. A manager of two agencies would otherwise
          -- write region_code/DPA onto an arbitrary one, and possibly a
          -- different one next request. Region drives rankability, so the wrong
          -- agency silently stops being rankable.
          ORDER BY om.created_at ASC
          LIMIT 1`,
        [userId],
      );
      if (!managed) {
        throw new BadRequestException('agency_profile_is_company_only');
      }
      targetUserId = managed.org_user_id;
    }
    const region = dto.region_code.trim().toUpperCase();
    // Server allow-list — a typo'd region silently makes the agency un-rankable, so reject it.
    // Keep in sync with OrgComplianceScreen.REGIONS (the licence/insurance region picker) so
    // agents.region_code can never diverge from the compliance_credentials.region_code the
    // eligibility fn matches on.
    // Canonical region list (incl. ZA per the 2026-06-25 decision) — single source
    // shared with booking + compliance so agents.region_code can never diverge.
    if (!SUPPORTED_REGION_CODES.includes(region)) {
      throw new BadRequestException('unsupported_region');
    }
    const row = await this.db.qOne<{region_code: string | null; dpa_accepted_at: Date | null}>(
      `UPDATE public.agents
          SET region_code    = $2,
              dpa_accepted_at = CASE WHEN $3 THEN COALESCE(dpa_accepted_at, NOW()) ELSE dpa_accepted_at END,
              dpa_version     = CASE WHEN $3 THEN $4 ELSE dpa_version END,
              updated_at      = NOW()
        WHERE user_id = $1
        RETURNING region_code, dpa_accepted_at`,
      [targetUserId, region, dto.dpa_accepted === true, dto.dpa_version ?? 'v1'],
    );
    if (!row) {
      throw new NotFoundException('agent_not_found');
    }
    return {region_code: row.region_code, dpa_accepted_at: row.dpa_accepted_at?.toISOString() ?? null};
  }

  async setDuty(userId: string, onDuty: boolean): Promise<void> {
    await this.requireAgent(userId);
    await this.db.q(`UPDATE agents SET on_duty = $2 WHERE user_id = $1`, [userId, onDuty]);
    // Keep the dispatch pool in sync. Without this, the cpo_pool mirror
    // stays at whatever ops.service.mirrorAgentToPool set on approval —
    // so toggling On Duty in the mobile app does NOT make the agent
    // visible to `cpoAssign.assignSpecific`. Guarded so an agent who's
    // currently mid-mission (`availability='on_mission'`) doesn't
    // accidentally flip themselves back to 'available' by toggling.
    //
    // NB: cpo_pool is keyed by the agent's user_id AS its `id` column
    // (mirrorAgentToPool inserts `a.user_id` into cpo_pool.id) — there is
    // no `user_id` column. The previous `WHERE user_id = $1` threw at
    // runtime, so the pool never synced and stale 'on_mission' rows from
    // aborted missions lingered (surfacing as `cpo_unavailable` at dispatch).
    if (onDuty) {
      // Only flip an idle 'off_duty' row up to 'available'. Never touch an
      // 'on_mission' row (the agent is actively crewed). The enum has exactly
      // three labels — available | on_mission | off_duty — so guard on those.
      await this.db.q(
        `UPDATE cpo_pool SET availability = 'available'
           WHERE id = $1 AND availability = 'off_duty'`,
        [userId],
      );
    } else {
      // Off-duty mid-mission stays 'on_mission' (ops releases it on
      // mission complete). Otherwise mark 'off_duty' so assignment
      // queries skip the agent cleanly.
      await this.db.q(
        `UPDATE cpo_pool SET availability = 'off_duty'
           WHERE id = $1 AND availability = 'available'`,
        [userId],
      );
    }
  }

  async updateLocation(
    userId: string, lat: number, lng: number,
    quality?: {accuracy_m?: number; speed_kph?: number; is_mocked?: boolean},
  ): Promise<void> {
    const agent = await this.requireAgent(userId);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException('invalid_coords');
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new BadRequestException('coords_out_of_range');
    }

    // Step 23 anti-fraud — plausibility + mock gating. A position the client flags
    // as mocked, OR a teleport that implies an impossible ground speed vs the last
    // fix, is recorded as `mocked` but does NOT advance last_location — so a spoofed
    // fix can neither win dispatch (the GiST ranking reads last_location, which goes
    // stale) nor pass the ranking's explicit `last_location_mocked = FALSE` gate.
    const toNum = (v: string | number | null | undefined): number | null =>
      v === null || v === undefined ? null : Number(v);
    const prevLat = toNum(agent.last_lat);
    const prevLng = toNum(agent.last_lng);
    const prevAt = agent.last_location_at ? new Date(agent.last_location_at).getTime() : null;
    let implausible = false;
    if (prevLat !== null && prevLng !== null && prevAt !== null) {
      const dtSec = (Date.now() - prevAt) / 1_000;
      // Skip near-simultaneous fixes — at tiny dt, jitter looks like huge speed.
      if (dtSec >= MIN_PLAUSIBILITY_DT_SECONDS) {
        const km = haversineKm(prevLat, prevLng, lat, lng);
        // Allowed displacement = what MAX_PLAUSIBLE_KPH permits over dt, PLUS the two
        // fixes' combined position uncertainty (a poor-accuracy fix can't be mistaken
        // for a teleport). Only a jump beyond BOTH is treated as a spoof.
        // FRAUD-3 — each reported accuracy is capped so a spoofed high-uncertainty fix
        // can't inflate the allowed jump.
        const capAcc = (m: number | null): number => Math.min(Math.max(m ?? 0, 0), MAX_ACCURACY_SLACK_M);
        const accM = capAcc(quality?.accuracy_m ?? null) + capAcc(toNum(agent.last_location_accuracy_m)) + GPS_JITTER_FLOOR_M;
        const allowedKm = MAX_PLAUSIBLE_KPH * (dtSec / 3_600) + accM / 1_000;
        if (km > allowedKm) {implausible = true;}
      }
    }
    const mocked = quality?.is_mocked === true || implausible;

    if (mocked) {
      // INVARIANT: a mocked/implausible fix records the flag but DELIBERATELY does not
      // touch last_location / last_location_at. Double protection: (1) the ranking's
      // explicit `last_location_mocked = FALSE` gate excludes the agency immediately,
      // and (2) since last_location_at isn't refreshed, the agency also goes stale and
      // drops out via the freshness gate. The flag self-heals on the next genuine fix
      // (the else-branch sets it FALSE). Never log the coords (PII).
      await this.db.q(
        `UPDATE agents
            SET last_location_mocked = TRUE,
                last_location_accuracy_m = COALESCE($2, last_location_accuracy_m)
          WHERE user_id = $1`,
        [userId, quality?.accuracy_m ?? null],
      );
      return;
    }

    await this.db.q(
      // last_location (PostGIS geography) backs the dispatch nearest-agency GiST
      // ranking (Step 6); keep it in sync with last_lat/last_lng on every fix.
      // extensions.* is fully qualified so it resolves regardless of the
      // connection's search_path.
      `UPDATE agents
          SET last_lat = $2, last_lng = $3, last_location_at = NOW(),
              last_location = extensions.ST_SetSRID(extensions.ST_MakePoint($3, $2), 4326)::extensions.geography,
              last_location_mocked = FALSE,
              last_location_accuracy_m = COALESCE($4, last_location_accuracy_m)
        WHERE user_id = $1`,
      [userId, lat, lng, quality?.accuracy_m ?? null],
    );
  }

  async bumpStats(userId: string, d: {duty_hours_delta?: number; jobs_delta?: number}): Promise<void> {
    await this.requireAgent(userId);
    await this.db.q(
      `UPDATE agents
          SET duty_hours_mtd = duty_hours_mtd + COALESCE($2, 0),
              jobs_total     = jobs_total + COALESCE($3, 0)
        WHERE user_id = $1`,
      [userId, d.duty_hours_delta ?? 0, d.jobs_delta ?? 0],
    );
  }

  // ─── 09 · Deployment ──────────────────────────────────────────

  /**
   * @deprecated — moved to `OpsService.signoffMissionDeployment` (mission-scoped).
   *
   * The previous implementation matched only `(user_id, check_key)` which
   * cross-flipped state across every mission the agent was seeded onto.
   * Keep the method body for any internal callers but require an
   * explicit `mission_id` so the cross-mission bug can't recur.
   */
  async signOffDeployment(
    userId: string,
    opsId: string,
    dto: DeploymentSignOffDto & {mission_id: string},
  ): Promise<void> {
    await this.requireAgent(userId);
    if (!dto.mission_id) {
      throw new BadRequestException('mission_id_required');
    }
    await this.db.q(
      `UPDATE agent_deployment_checks
          SET state = $3, signed_by = $2, signed_at = NOW(), notes = $4
        WHERE user_id = $1 AND check_key = $5 AND mission_id = $6`,
      [userId, opsId, dto.state, dto.notes ?? null, dto.check_key, dto.mission_id],
    );

    // When all checks for THIS mission are 'passed', activate the agent.
    // Scoped to mission_id so a future stale mission's rows can't gate
    // activation against the current mission.
    const remaining = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n FROM agent_deployment_checks
        WHERE user_id = $1 AND mission_id = $2 AND state <> 'passed'`,
      [userId, dto.mission_id],
    );
    if (remaining && Number(remaining.n) === 0) {
      await this.transitionIfAt(userId, 'APPROVED', 'ACTIVE', 'OPS', {reason: 'deployment_complete'});
      await this.db.q(`UPDATE agents SET activated_at = NOW() WHERE user_id = $1`, [userId]);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async requireAgent(userId: string): Promise<AgentRow> {
    const row = await this.db.qOne<AgentRow>(
      `SELECT * FROM agents WHERE user_id = $1`, [userId],
    );
    if (!row) throw new NotFoundException('Agent not found');
    return row;
  }

  private async transitionIfAt(
    userId: string,
    from: AgentStatus,
    to: AgentStatus,
    actor: AgentActorRole,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const row = await this.db.qOne<{status: AgentStatus}>(
      `SELECT status FROM agents WHERE user_id = $1`, [userId],
    );
    if (!row || row.status !== from) return;
    this.fsm.assert(from, to, actor);
    await this.db.q(`UPDATE agents SET status = $2 WHERE user_id = $1`, [userId, to]);
    await this.audit(userId, from, to, userId, actor, metadata);
  }

  // Why the optional `q`: when called INSIDE withTransaction the insert MUST
  // ride the same connection. Writing via the pool from inside an open tx
  // cross-deadlocks under concurrency — the audit insert takes an FK key-share
  // lock on the agents row another in-flight decide() tx holds exclusively,
  // while that tx awaits its own pool-audit. Observed live on Contabo
  // (2026-06-11): two approve clicks → both connections wedged, ops UI stuck
  // on "APPROVING…" (B-24).
  private async audit(
    userId: string,
    from: AgentStatus | null,
    to: AgentStatus,
    actorId: string,
    actorRole: AgentActorRole,
    metadata: Record<string, unknown> = {},
    q: Pick<DatabaseService, 'q'> = this.db,
  ): Promise<void> {
    try {
      await q.q(
        `INSERT INTO agent_audit (user_id, from_status, to_status, actor_id, actor_role, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [userId, from, to, actorId, actorRole, JSON.stringify(metadata)],
      );
    } catch (e) {
      this.log.warn(`audit insert failed for ${userId}: ${(e as Error).message}`);
    }
  }
}
