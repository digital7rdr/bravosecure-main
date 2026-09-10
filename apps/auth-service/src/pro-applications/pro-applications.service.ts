import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import * as crypto from 'node:crypto';
import {DatabaseService, type Tx} from '../database/database.service';
import {WalletService} from '../wallet/wallet.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {type AdminContext} from '../ops/admin.guard';
import {ProApplicationStateMachine, type ProApplicationStatus} from './state-machine.service';
import {
  CreateProApplicationDto, CreateProposalDto, PRO_SERVICE_KEYS,
} from './dto/pro-application.dto';

// Row shapes (raw SQL — no entity layer in this service, matching the repo).
export interface ProApplicationRow {
  id: string;
  user_id: string;
  status: ProApplicationStatus;
  intended_use: string;
  intended_use_note: string | null;
  duration_months: number | null;
  duration_note: string | null;
  start_date: string;
  coverage_area: string;
  cpo_count: number;
  driver_count: number;
  support_staff_count: number;
  gender_preference: string;
  services: string[];
  service_other_note: string | null;
  notes: string | null;
  rejected_reason: string | null;
  submitted_at: string;
  updated_at: string;
  activated_at: string | null;
  current_period_end: string | null;
  /** Last COVERED day (current_period_end − 1 day) — what every UI should show. */
  covered_until?: string | null;
}

export interface ProProposalRow {
  id: string;
  application_id: string;
  version: number;
  proposal_number: string;
  valid_until: string;
  coverage_start: string;
  coverage_end: string;
  /** Total BC for the whole coverage period — debited once at activation. */
  total_credits: number;
  included_services: string[];
  assigned_team: Array<{role: string; count: number; label?: string}>;
  terms: string | null;
  created_at: string;
}

export interface ProEventRow {
  id: string;
  event: string;
  actor: 'client' | 'ops' | 'system';
  message: string | null;
  created_at: string;
}

export interface ProMessageRow {
  id: string;
  sender: 'client' | 'ops';
  body: string;
  created_at: string;
}

export interface ProMissionRow {
  id: string;
  application_id: string;
  requested_by: string;
  mission_dates: string[];
  note: string | null;
  status: 'REQUESTED' | 'SCHEDULED' | 'DECLINED' | 'COMPLETED';
  assigned_team: Array<{role: string; count: number; label?: string}>;
  ops_note: string | null;
  created_at: string;
  requested_by_name?: string | null;
}

export interface ClientProApplication extends ProApplicationRow {
  proposal: ProProposalRow | null;
  events: ProEventRow[];
  /** Set when this is the FAMILY OWNER's plan surfaced to an active member. */
  via_owner?: {name: string} | null;
}

// Client-visible columns — internal_notes / decided_by / decided_at stay ops-side.
const CLIENT_COLS = `
  id, user_id, status, intended_use, intended_use_note,
  duration_months, duration_note, start_date::text AS start_date,
  coverage_area, cpo_count, driver_count, support_staff_count,
  gender_preference, services, service_other_note, notes, rejected_reason,
  submitted_at, updated_at, activated_at, current_period_end,
  -- B-383 follow-up: current_period_end is the EXCLUSIVE end of coverage (it
  -- drives sweepExpired). Every "covered until" surface wants the LAST COVERED
  -- DAY, so derive it here instead of letting each reader subtract a day —
  -- rendering current_period_end directly is off by one.
  (current_period_end - interval '1 day')::date::text AS covered_until
`;

const PROPOSAL_COLS = `
  id, application_id, version, proposal_number, valid_until,
  coverage_start::text AS coverage_start, coverage_end::text AS coverage_end,
  total_credits, included_services, assigned_team, terms, created_at
`;

const OPEN_STATUSES: readonly ProApplicationStatus[] =
  ['PENDING_PROPOSAL', 'PROPOSAL_CREATED', 'REVISION_REQUESTED', 'ACCEPTED', 'ACTIVE'];

const MISSION_COLS = `
  id, application_id, requested_by, mission_dates::text[] AS mission_dates,
  note, status, assigned_team, ops_note, created_at
`;

/** E-11 — "today" for past-date checks is the UAE (UTC+4, no DST) calendar day,
 *  not the UTC one: a user submitting their local "today" in the UTC-lag window
 *  was rejected with date_in_past for a date that had not passed. */
function todayGulf(): string {
  return new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
}

/** Sanitise free-shape [{role, count, label?}] team entries (proposals + missions). */
function sanitizeTeam(entries: Array<Record<string, unknown>> | undefined): Array<{role: string; count: number; label?: string}> {
  return (entries ?? [])
    .map(t => ({
      role: String(t.role ?? '').slice(0, 60),
      count: Math.max(1, Math.min(50, Number(t.count) || 1)),
      ...(t.label ? {label: String(t.label).slice(0, 120)} : {}),
    }))
    .filter(t => t.role.length > 0);
}

@Injectable()
export class ProApplicationsService {
  private readonly log = new Logger(ProApplicationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly wallet: WalletService,
    private readonly fsm: ProApplicationStateMachine,
    private readonly events: MissionEventsService,
    private readonly push: BookingPushBridge,
  ) {}

  // ─── Client surface ────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateProApplicationDto): Promise<{application: ClientProApplication}> {
    // Cross-field requirements the class-validator layer can't express.
    if (dto.intended_use === 'custom' && !dto.intended_use_note?.trim()) {
      throw new BadRequestException('intended_use_note required for custom use');
    }
    if (!dto.duration_months && !dto.duration_note?.trim()) {
      throw new BadRequestException('duration_months or duration_note required');
    }
    if (dto.services.includes('other') && !dto.service_other_note?.trim()) {
      throw new BadRequestException('service_other_note required when other is selected');
    }
    const today = todayGulf();
    if (dto.start_date < today) {
      throw new BadRequestException('start_date cannot be in the past');
    }
    if (dto.cpo_count + dto.driver_count + dto.support_staff_count < 1) {
      throw new BadRequestException('at least one team member required');
    }
    const services = [...new Set(dto.services)].filter(s =>
      (PRO_SERVICE_KEYS as readonly string[]).includes(s));

    try {
      const app = await this.db.withTransaction(async tx => {
        const row = await tx.qOne<ProApplicationRow>(
          `INSERT INTO pro_applications
             (user_id, intended_use, intended_use_note, duration_months, duration_note,
              start_date, coverage_area, cpo_count, driver_count, support_staff_count,
              gender_preference, services, service_other_note, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
           RETURNING ${CLIENT_COLS}`,
          [
            userId, dto.intended_use, dto.intended_use_note?.trim() ?? null,
            dto.duration_months ?? null, dto.duration_note?.trim() ?? null,
            dto.start_date, dto.coverage_area.trim(),
            dto.cpo_count, dto.driver_count, dto.support_staff_count,
            dto.gender_preference, JSON.stringify(services),
            dto.service_other_note?.trim() ?? null, dto.notes?.trim() ?? null,
          ],
        );
        if (!row) {throw new BadRequestException('insert failed');}
        await this.recordEvent(tx, row.id, 'client', 'application.submitted',
          'Application submitted — awaiting a proposal from the Bravo Control System');
        return row;
      });
      // Fire-and-forget notifications AFTER commit — a delivery miss never
      // fails the mutation (clients poll as fallback).
      void this.events.broadcast(app.id, 'proapp.status', {status: app.status}).catch(() => undefined);
      void this.push.proApplicationReceived(userId, app.id).catch(() => undefined);
      return {application: await this.attachClientDetail(app)};
    } catch (e) {
      if ((e as {code?: string}).code === '23505') {
        throw new BadRequestException('pro_application_exists');
      }
      throw e;
    }
  }

  /**
   * Lazy expiry sweep — flips ACTIVE plans past coverage_end to EXPIRED on the
   * read path (no cron). Idempotent, indexed by status, cheap when nothing
   * matches; per-flip timeline event via the CTE.
   */
  private async sweepExpired(): Promise<void> {
    try {
      await this.db.q(
        `WITH flipped AS (
           UPDATE pro_applications SET status = 'EXPIRED', updated_at = now()
            WHERE status = 'ACTIVE' AND current_period_end IS NOT NULL AND current_period_end < now()
            RETURNING id)
         INSERT INTO pro_application_events (application_id, actor, event, message)
         SELECT id, 'system', 'plan.expired', 'Coverage period ended' FROM flipped`,
      );
    } catch (e) {
      // Never let the sweep break a read.
      this.log.warn(`expiry sweep failed: ${(e as Error).message}`);
    }
  }

  /** Compact previous-application rows for the client + ops history views. */
  private async historyFor(userId: string, excludeId?: string): Promise<Array<Record<string, unknown>>> {
    return this.db.q(
      `SELECT pa.id, pa.status, pa.intended_use, pa.submitted_at, pa.activated_at,
              pa.current_period_end, p.total_credits,
              p.coverage_start::text AS coverage_start, p.coverage_end::text AS coverage_end
         FROM pro_applications pa
         LEFT JOIN LATERAL (
           SELECT total_credits, coverage_start, coverage_end FROM pro_proposals
            WHERE application_id = pa.id ORDER BY version DESC LIMIT 1
         ) p ON TRUE
        WHERE pa.user_id = $1 ${excludeId ? 'AND pa.id <> $2' : ''}
        ORDER BY pa.submitted_at DESC LIMIT 20`,
      excludeId ? [userId, excludeId] : [userId],
    );
  }

  async getMine(userId: string): Promise<{application: ClientProApplication | null; history: Array<Record<string, unknown>>}> {
    await this.sweepExpired();
    const app = await this.db.qOne<ProApplicationRow>(
      `SELECT ${CLIENT_COLS} FROM pro_applications
        WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
      [userId],
    );
    if (app) {
      return {
        application: await this.attachClientDetail(app),
        history: await this.historyFor(userId, app.id),
      };
    }

    // No application of their own — an active (non-held) family member rides
    // the OWNER's ACTIVE plan: same dashboard, badge "under the owner".
    const holder = await this.db.qOne<{holder_id: string; holder_name: string | null}>(
      `SELECT fm.holder_id, h.display_name AS holder_name
         FROM public.family_members fm
         JOIN public.users h ON h.id = fm.holder_id
        WHERE fm.member_id = $1 AND fm.status = 'active'
          AND (fm.held_until IS NULL OR fm.held_until <= NOW())`,
      [userId],
    );
    if (!holder) {return {application: null, history: []};}
    const ownerApp = await this.db.qOne<ProApplicationRow>(
      `SELECT ${CLIENT_COLS} FROM pro_applications
        WHERE user_id = $1 AND status = 'ACTIVE'
        ORDER BY submitted_at DESC LIMIT 1`,
      [holder.holder_id],
    );
    if (!ownerApp) {return {application: null, history: []};}
    const detailed = await this.attachClientDetail(ownerApp);
    return {application: {...detailed, via_owner: {name: holder.holder_name ?? 'Family owner'}}, history: []};
  }

  /**
   * One-tap renewal — a fresh application copying the previous one's details
   * (founder: "simple button for renew with current details"). Allowed once
   * the old plan is EXPIRED (or REJECTED). Start date rolls forward to the
   * day after the old coverage ended (or today, whichever is later).
   */
  async renew(userId: string, id: string): Promise<{application: ClientProApplication}> {
    const old = await this.db.qOne<ProApplicationRow & {duration_months: number | null}>(
      `SELECT ${CLIENT_COLS} FROM pro_applications WHERE id = $1`, [id]);
    if (!old) {throw new NotFoundException('pro_application_not_found');}
    if (old.user_id !== userId) {throw new ForbiddenException('not_your_application');}
    if (old.status !== 'EXPIRED' && old.status !== 'REJECTED') {
      throw new BadRequestException('plan_not_renewable');
    }
    const today = todayGulf();
    const oldEnd = old.current_period_end ? new Date(old.current_period_end).toISOString().slice(0, 10) : today;
    const startDate = oldEnd > today ? oldEnd : today;

    try {
      const app = await this.db.withTransaction(async tx => {
        const row = await tx.qOne<ProApplicationRow>(
          `INSERT INTO pro_applications
             (user_id, intended_use, intended_use_note, duration_months, duration_note,
              start_date, coverage_area, cpo_count, driver_count, support_staff_count,
              gender_preference, services, service_other_note, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
           RETURNING ${CLIENT_COLS}`,
          [
            userId, old.intended_use, old.intended_use_note, old.duration_months,
            old.duration_note, startDate, old.coverage_area,
            old.cpo_count, old.driver_count, old.support_staff_count,
            old.gender_preference, JSON.stringify(old.services),
            old.service_other_note, old.notes,
          ],
        );
        if (!row) {throw new BadRequestException('insert failed');}
        await this.recordEvent(tx, row.id, 'client', 'application.submitted',
          'Renewal requested with previous plan details — awaiting a proposal from the Bravo Control System');
        return row;
      });
      void this.events.broadcast(app.id, 'proapp.status', {status: app.status}).catch(() => undefined);
      void this.push.proApplicationReceived(userId, app.id).catch(() => undefined);
      return {application: await this.attachClientDetail(app)};
    } catch (e) {
      if ((e as {code?: string}).code === '23505') {
        throw new BadRequestException('pro_application_exists');
      }
      throw e;
    }
  }

  async accept(userId: string, id: string): Promise<{application: ClientProApplication}> {
    const app = await this.db.withTransaction(async tx => {
      const row = await this.lockOwned(tx, userId, id);
      this.fsm.assert(row.status, 'ACCEPTED', 'CLIENT');
      const proposal = await this.latestProposal(tx, id);
      if (!proposal) {throw new BadRequestException('no_proposal');}
      if (new Date(proposal.valid_until).getTime() < Date.now()) {
        throw new BadRequestException('proposal_expired');
      }
      const updated = await this.guardedStatusUpdate(tx, id, row.status, 'ACCEPTED');
      await this.recordEvent(tx, id, 'client', 'proposal.accepted',
        `Proposal ${proposal.proposal_number} accepted`);
      return updated;
    });
    void this.events.broadcast(id, 'proapp.status', {status: app.status}).catch(() => undefined);
    return {application: await this.attachClientDetail(app)};
  }

  async requestChanges(userId: string, id: string, message: string): Promise<{application: ClientProApplication}> {
    const app = await this.db.withTransaction(async tx => {
      const row = await this.lockOwned(tx, userId, id);
      this.fsm.assert(row.status, 'REVISION_REQUESTED', 'CLIENT');
      const updated = await this.guardedStatusUpdate(tx, id, row.status, 'REVISION_REQUESTED');
      await tx.q(
        `INSERT INTO pro_application_messages (application_id, sender, sender_id, body)
         VALUES ($1,'client',$2,$3)`,
        [id, userId, message.trim()],
      );
      await this.recordEvent(tx, id, 'client', 'revision.requested',
        'Changes requested on the proposal');
      return updated;
    });
    void this.events.broadcast(id, 'proapp.status', {status: app.status}).catch(() => undefined);
    void this.events.broadcast(id, 'proapp.message', {}).catch(() => undefined);
    return {application: await this.attachClientDetail(app)};
  }

  /**
   * Pay & activate — debits the proposal's TOTAL Bravo Credits (the whole
   * coverage period, founder rule: not month-wise) and flips ACCEPTED → ACTIVE
   * in ONE transaction; a failed debit rolls everything back. The plan runs to
   * the proposal's coverage_end. NEVER touches users.subscription_tier.
   */
  async activate(userId: string, id: string): Promise<{application: ClientProApplication}> {
    let total = 0;
    const app = await this.db.withTransaction(async tx => {
      const row = await this.lockOwned(tx, userId, id);
      this.fsm.assert(row.status, 'ACTIVE', 'SYSTEM');
      const proposal = await this.latestProposal(tx, id);
      if (!proposal) {throw new BadRequestException('no_proposal');}
      // B-381 — the money step must re-check what accept() checked: a client who
      // accepted then stalled (top-up, days away) could be debited the FULL
      // period for stale terms — or for coverage that already ELAPSED, which
      // sweepExpired would flip to EXPIRED on the very next read with no refund
      // path from ACTIVE.
      if (new Date(proposal.valid_until).getTime() < Date.now()) {
        throw new BadRequestException('proposal_expired');
      }
      const coverageEndMs = new Date(proposal.coverage_end).getTime() + 24 * 3600_000;
      if (coverageEndMs <= Date.now()) {
        throw new BadRequestException('coverage_elapsed');
      }
      total = proposal.total_credits;
      await this.wallet.debitForFeature(
        userId, proposal.total_credits,
        'Bravo Secure Pro — plan activation (full period)',
        {kind: 'pro_application', application_id: id, proposal_id: proposal.id, version: proposal.version},
        tx,
        {feature: 'secure_pro_plan'},
      );
      // B-383 — period end is EXCLUSIVE end-of-final-day (coverage_end + 1 day).
      // `coverage_end::date::timestamptz` was midnight at the START of the final
      // day, so sweepExpired killed every plan the moment its advertised last
      // day began while requestMission still accepted that date.
      const updated = await tx.qOne<ProApplicationRow>(
        `UPDATE pro_applications
            SET status = 'ACTIVE', activated_at = now(),
                current_period_end = ($3::date + 1)::timestamptz, updated_at = now()
          WHERE id = $1 AND status = $2
          RETURNING ${CLIENT_COLS}`,
        [id, row.status, proposal.coverage_end],
      );
      if (!updated) {throw new BadRequestException('pro_application_state_changed_concurrently');}
      await this.recordEvent(tx, id, 'system', 'plan.activated',
        `Plan activated — ${proposal.total_credits.toLocaleString()} BC for the full period`);
      return updated;
    });
    void this.events.broadcast(id, 'proapp.status', {status: app.status}).catch(() => undefined);
    void this.push.proPlanActivated(userId, id, total).catch(() => undefined);
    return {application: await this.attachClientDetail(app)};
  }

  // ─── In-plan missions (multi-date protection requests) ────────────────────

  /**
   * Owner or an ACTIVE (non-held) linked member of the owner may act on an
   * ACTIVE plan. Returns the application row.
   */
  private async assertPlanAccess(userId: string, id: string): Promise<ProApplicationRow> {
    const app = await this.db.qOne<ProApplicationRow>(
      `SELECT ${CLIENT_COLS} FROM pro_applications WHERE id = $1`, [id]);
    if (!app) {throw new NotFoundException('pro_application_not_found');}
    if (app.user_id !== userId) {
      const member = await this.db.qOne<{id: string}>(
        `SELECT id FROM public.family_members
          WHERE member_id = $1 AND holder_id = $2 AND status = 'active'
            AND (held_until IS NULL OR held_until <= NOW())`,
        [userId, app.user_id],
      );
      if (!member) {throw new ForbiddenException('not_your_application');}
    }
    return app;
  }

  async requestMission(userId: string, id: string, dates: string[], note?: string): Promise<{mission: ProMissionRow}> {
    const app = await this.assertPlanAccess(userId, id);
    if (app.status !== 'ACTIVE') {throw new BadRequestException('plan_not_active');}
    const proposal = await this.latestProposal(this.db, id);
    if (!proposal) {throw new BadRequestException('no_proposal');}

    const today = todayGulf();
    const unique = [...new Set(dates)].sort();
    if (unique.length < 1) {throw new BadRequestException('at_least_one_date');}
    for (const d of unique) {
      if (d < today) {throw new BadRequestException('date_in_past');}
      if (d < proposal.coverage_start || d > proposal.coverage_end) {
        throw new BadRequestException('date_outside_coverage');
      }
    }

    // Dedicated-officer fast path: when ops already assigned officer(s) whose
    // ASSIGNED window on THIS plan covers every requested date, the request
    // routes straight to them — no ops re-approval. The officer's mission view
    // derives its dates from SCHEDULED rows, so it picks these up immediately.
    const dedicated = await this.db.q<{cpo_user_id: string; cpo_name: string | null}>(
      `SELECT pca.cpo_user_id, u.display_name AS cpo_name
         FROM pro_cpo_assignments pca
         JOIN users u ON u.id = pca.cpo_user_id
        WHERE pca.application_id = $1 AND pca.status = 'ASSIGNED'
          AND daterange(pca.starts_on, pca.ends_on, '[]') @> daterange($2::date, $3::date, '[]')`,
      [id, unique[0], unique[unique.length - 1]],
    );
    if (dedicated.length > 0) {
      const names = dedicated.map(d => d.cpo_name ?? 'Officer');
      const team = [{role: 'Close Protection Officer', count: dedicated.length, label: names.join(', ')}];
      const mission = await this.db.qOne<ProMissionRow>(
        `INSERT INTO pro_plan_missions (application_id, requested_by, mission_dates, note, status, assigned_team)
         VALUES ($1, $2, $3::date[], $4, 'SCHEDULED', $5::jsonb)
         RETURNING ${MISSION_COLS}`,
        [id, userId, unique, note?.trim() || null, JSON.stringify(team)],
      );
      await this.db.q(
        `INSERT INTO pro_application_events (application_id, actor, event, message)
         VALUES ($1,'system','mission.scheduled',$2)`,
        [id, `Protection scheduled — dedicated officer ${names.join(', ')} (${unique.length} date${unique.length > 1 ? 's' : ''})`],
      );
      void this.events.broadcast(id, 'proapp.message', {}).catch(() => undefined);
      void this.push.proMissionUpdate(app.user_id, id, 'SCHEDULED').catch(() => undefined);
      return {mission: mission!};
    }

    const mission = await this.db.qOne<ProMissionRow>(
      `INSERT INTO pro_plan_missions (application_id, requested_by, mission_dates, note)
       VALUES ($1, $2, $3::date[], $4)
       RETURNING ${MISSION_COLS}`,
      [id, userId, unique, note?.trim() || null],
    );
    await this.db.q(
      `INSERT INTO pro_application_events (application_id, actor, event, message)
       VALUES ($1,'client','mission.requested',$2)`,
      [id, `Protection requested for ${unique.length} date${unique.length > 1 ? 's' : ''}`],
    );
    void this.events.broadcast(id, 'proapp.message', {}).catch(() => undefined);
    return {mission: mission!};
  }

  async listMissions(userId: string, id: string): Promise<{missions: ProMissionRow[]}> {
    await this.assertPlanAccess(userId, id);
    const missions = await this.db.q<ProMissionRow>(
      `SELECT ${MISSION_COLS} FROM pro_plan_missions WHERE application_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [id],
    );
    return {missions};
  }

  /**
   * The plan's live protection team + assigned vehicles + resources — the
   * ops-assigned dedicated officers (pro_cpo_assignments) and the Issue-30
   * fleet/resource links, in ONE client round-trip. Client-visible projections
   * ONLY:
   *  - team: identity + window. mission_code is the OFFICER's gate credential
   *    and must never reach the member (foreign codes are deliberately
   *    indistinguishable from unknown).
   *  - vehicles: plate IS shown (Issue 30 headline).
   *  - resources: the ops-internal `identifier` (serial) is WITHHELD — same
   *    discipline as mission_code never reaching the member.
   */
  async listTeam(userId: string, id: string): Promise<{
    team: Array<Record<string, unknown>>;
    vehicles: Array<Record<string, unknown>>;
    resources: Array<Record<string, unknown>>;
  }> {
    await this.assertPlanAccess(userId, id);
    const team = await this.db.q(
      `SELECT pca.id, pca.cpo_user_id,
              pca.starts_on::text AS starts_on, pca.ends_on::text AS ends_on,
              u.display_name AS cpo_name, u.avatar_url,
              om.call_sign, og.display_name AS org_name,
              (CURRENT_DATE BETWEEN pca.starts_on AND pca.ends_on) AS live_today
         FROM pro_cpo_assignments pca
         JOIN users u ON u.id = pca.cpo_user_id
         LEFT JOIN agents og ON og.user_id = pca.org_user_id
         LEFT JOIN org_members om
           ON om.member_user_id = pca.cpo_user_id AND om.org_user_id = pca.org_user_id
        WHERE pca.application_id = $1 AND pca.status = 'ASSIGNED'
        ORDER BY pca.starts_on ASC
        LIMIT 50`,
      [id],
    );
    const vehicles = await this.db.q(
      `SELECT pva.id, v.call_sign, v.make_model, v.plate, v.colour,
              v.armored, v.armor_grade, v.capacity,
              pva.starts_on::text AS starts_on, pva.ends_on::text AS ends_on,
              (CURRENT_DATE BETWEEN pva.starts_on AND pva.ends_on) AS live_today
         FROM pro_vehicle_assignments pva
         JOIN pro_fleet_vehicles v ON v.id = pva.vehicle_id
        WHERE pva.application_id = $1 AND pva.status = 'ASSIGNED'
        ORDER BY pva.starts_on ASC
        LIMIT 50`,
      [id],
    );
    // identifier (serial) is deliberately NOT selected — ops-internal only.
    const resources = await this.db.q(
      `SELECT pra.id, r.kind, r.label, pra.qty,
              pra.starts_on::text AS starts_on, pra.ends_on::text AS ends_on,
              (CURRENT_DATE BETWEEN pra.starts_on AND pra.ends_on) AS live_today
         FROM pro_resource_assignments pra
         JOIN pro_resources r ON r.id = pra.resource_id
        WHERE pra.application_id = $1 AND pra.status = 'ASSIGNED'
        ORDER BY r.kind ASC, pra.starts_on ASC
        LIMIT 50`,
      [id],
    );
    return {team, vehicles, resources};
  }

  async scheduleMission(
    admin: AdminContext, id: string, missionId: string,
    team: Array<Record<string, unknown>> | undefined, opsNote?: string,
  ): Promise<{mission: ProMissionRow}> {
    return this.decideMission(admin, id, missionId, 'SCHEDULED', sanitizeTeam(team), opsNote);
  }

  async declineMission(admin: AdminContext, id: string, missionId: string, opsNote?: string): Promise<{mission: ProMissionRow}> {
    return this.decideMission(admin, id, missionId, 'DECLINED', [], opsNote);
  }

  private async decideMission(
    admin: AdminContext, id: string, missionId: string,
    to: 'SCHEDULED' | 'DECLINED',
    team: Array<{role: string; count: number; label?: string}>, opsNote?: string,
  ): Promise<{mission: ProMissionRow}> {
    const result = await this.db.withTransaction(async tx => {
      const app = await tx.qOne<{user_id: string}>(
        `SELECT user_id FROM pro_applications WHERE id = $1 FOR UPDATE`, [id]);
      if (!app) {throw new NotFoundException('pro_application_not_found');}
      const mission = await tx.qOne<ProMissionRow>(
        `UPDATE pro_plan_missions
            SET status = $3, assigned_team = $4::jsonb, ops_note = $5,
                decided_by = $6, updated_at = now()
          WHERE id = $1 AND application_id = $2 AND status = 'REQUESTED'
          RETURNING ${MISSION_COLS}`,
        [missionId, id, to, JSON.stringify(team), opsNote?.trim() || null, admin.user_id],
      );
      if (!mission) {throw new BadRequestException('mission_not_requestable');}
      await tx.q(
        `INSERT INTO pro_application_events (application_id, actor, event, message)
         VALUES ($1,'ops',$2,$3)`,
        [id, to === 'SCHEDULED' ? 'mission.scheduled' : 'mission.declined',
          to === 'SCHEDULED'
            ? `Protection scheduled for ${mission.mission_dates.length} date${mission.mission_dates.length > 1 ? 's' : ''}`
            : 'A protection request was declined'],
      );
      return {mission, ownerId: app.user_id};
    });
    void this.events.broadcast(id, 'proapp.message', {}).catch(() => undefined);
    void this.push.proMissionUpdate(result.ownerId, id, to).catch(() => undefined);
    return {mission: result.mission};
  }

  async listMessages(userId: string, id: string): Promise<{messages: ProMessageRow[]}> {
    await this.assertOwned(userId, id);
    const messages = await this.db.q<ProMessageRow>(
      `SELECT id, sender, body, created_at FROM pro_application_messages
        WHERE application_id = $1 ORDER BY created_at ASC LIMIT 200`,
      [id],
    );
    return {messages};
  }

  async sendMessage(userId: string, id: string, body: string): Promise<{message: ProMessageRow}> {
    const row = await this.assertOwned(userId, id);
    if (row.status === 'REJECTED' || row.status === 'CANCELLED') {
      throw new BadRequestException('application_closed');
    }
    const message = await this.db.qOne<ProMessageRow>(
      `INSERT INTO pro_application_messages (application_id, sender, sender_id, body)
       VALUES ($1,'client',$2,$3)
       RETURNING id, sender, body, created_at`,
      [id, userId, body.trim()],
    );
    void this.events.broadcast(id, 'proapp.message', {}).catch(() => undefined);
    return {message: message!};
  }

  // ─── Ops surface ───────────────────────────────────────────────────────────

  async listForOps(status?: string, limit = 50): Promise<{applications: Array<Record<string, unknown>>}> {
    await this.sweepExpired();
    const cap = Math.min(Math.max(limit, 1), 200);
    const params: unknown[] = [];
    let where = '';
    if (status && status !== 'all') {
      if (status === 'open') {
        where = `WHERE pa.status = ANY($1)`;
        params.push([...OPEN_STATUSES.filter(s => s !== 'ACTIVE')]);
      } else {
        where = `WHERE pa.status = $1`;
        params.push(status);
      }
    }
    params.push(cap);
    // Why: actionable buckets (waiting on ops) drain oldest-first so nothing
    // starves at the bottom of the queue; every other view stays newest-first.
    const order = status === 'PENDING_PROPOSAL' || status === 'REVISION_REQUESTED'
      ? 'ASC' : 'DESC';
    const applications = await this.db.q(
      `SELECT pa.id, pa.status, pa.intended_use, pa.intended_use_note,
              pa.duration_months, pa.duration_note, pa.start_date::text AS start_date,
              pa.coverage_area, pa.cpo_count, pa.driver_count, pa.support_staff_count,
              pa.gender_preference, pa.services, pa.submitted_at, pa.updated_at,
              pa.activated_at, pa.current_period_end,
              (pa.current_period_end - interval '1 day')::date::text AS covered_until,
              u.display_name AS client_name, u.email AS client_email, u.phone_e164 AS client_phone,
              p.total_credits, p.version AS proposal_version
         FROM pro_applications pa
         JOIN users u ON u.id = pa.user_id
         LEFT JOIN LATERAL (
           SELECT total_credits, version FROM pro_proposals
            WHERE application_id = pa.id ORDER BY version DESC LIMIT 1
         ) p ON TRUE
         ${where}
        ORDER BY pa.submitted_at ${order}
        LIMIT $${params.length}`,
      params,
    );
    return {applications};
  }

  async getForOps(id: string): Promise<Record<string, unknown>> {
    await this.sweepExpired();
    const application = await this.db.qOne<{user_id: string}>(
      `SELECT pa.*, pa.start_date::text AS start_date,
              (pa.current_period_end - interval '1 day')::date::text AS covered_until,
              u.display_name AS client_name, u.email AS client_email, u.phone_e164 AS client_phone,
              du.display_name AS decided_by_name, du.email AS decided_by_email
         FROM pro_applications pa
         JOIN users u ON u.id = pa.user_id
         LEFT JOIN users du ON du.id = pa.decided_by
        WHERE pa.id = $1`,
      [id],
    );
    if (!application) {throw new NotFoundException('pro_application_not_found');}
    // Founder: ops sees the client's full past + present at a glance.
    const history = await this.historyFor(application.user_id, id);
    const proposals = await this.db.q<ProProposalRow>(
      `SELECT ${PROPOSAL_COLS} FROM pro_proposals
        WHERE application_id = $1 ORDER BY version DESC`,
      [id],
    );
    const events = await this.db.q<ProEventRow>(
      `SELECT id, event, actor, message, created_at FROM pro_application_events
        WHERE application_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id],
    );
    const messages = await this.db.q<ProMessageRow>(
      `SELECT id, sender, body, created_at FROM pro_application_messages
        WHERE application_id = $1 ORDER BY created_at ASC LIMIT 200`,
      [id],
    );
    const missions = await this.db.q<ProMissionRow>(
      `SELECT pm.id, pm.application_id, pm.requested_by,
              pm.mission_dates::text[] AS mission_dates, pm.note, pm.status,
              pm.assigned_team, pm.ops_note, pm.created_at,
              ru.display_name AS requested_by_name
         FROM pro_plan_missions pm
         LEFT JOIN public.users ru ON ru.id = pm.requested_by
        WHERE pm.application_id = $1
        ORDER BY pm.created_at DESC LIMIT 100`,
      [id],
    );
    // Linked family members ride the owner's ACTIVE plan (held members don't) —
    // ops must see who else this plan covers, incl. any hold window.
    const family = await this.db.q(
      `SELECT fm.id, fm.member_id, fm.status, fm.relationship, fm.held_until,
              fm.spend_limit_credits, fm.spent_credits, fm.invited_at, fm.accepted_at,
              COALESCE(mu.display_name, fm.invite_phone) AS member_name,
              mu.email AS member_email
         FROM public.family_members fm
         LEFT JOIN public.users mu ON mu.id = fm.member_id
        WHERE fm.holder_id = $1 AND fm.status IN ('pending','active')
        ORDER BY fm.invited_at DESC`,
      [application.user_id],
    );
    return {application, proposals, events, messages, missions, history, family};
  }

  async createProposal(admin: AdminContext, id: string, dto: CreateProposalDto): Promise<Record<string, unknown>> {
    if (dto.coverage_end < dto.coverage_start) {
      throw new BadRequestException('coverage_end before coverage_start');
    }
    if (new Date(dto.valid_until).getTime() <= Date.now()) {
      throw new BadRequestException('valid_until must be in the future');
    }
    const team = sanitizeTeam(dto.assigned_team);

    const result = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<ProApplicationRow>(
        `SELECT ${CLIENT_COLS} FROM pro_applications WHERE id = $1 FOR UPDATE`, [id]);
      if (!row) {throw new NotFoundException('pro_application_not_found');}
      this.fsm.assert(row.status, 'PROPOSAL_CREATED', 'OPS_HANDLER');
      const verRow = await tx.qOne<{next: number}>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM pro_proposals WHERE application_id = $1`,
        [id],
      );
      const version = verRow?.next ?? 1;
      const proposalId = crypto.randomUUID();
      const proposalNumber = `PR-${new Date().getUTCFullYear()}-${proposalId.slice(0, 4).toUpperCase()}`;
      const proposal = await tx.qOne<ProProposalRow>(
        `INSERT INTO pro_proposals
           (id, application_id, version, proposal_number, valid_until,
            coverage_start, coverage_end, total_credits, included_services,
            assigned_team, terms, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)
         RETURNING ${PROPOSAL_COLS}`,
        [
          proposalId, id, version, proposalNumber, dto.valid_until,
          dto.coverage_start, dto.coverage_end, dto.total_credits,
          JSON.stringify(dto.included_services.slice(0, 20)),
          JSON.stringify(team), dto.terms?.trim() ?? null, admin.user_id,
        ],
      );
      const updated = await this.guardedStatusUpdate(tx, id, row.status, 'PROPOSAL_CREATED');
      await this.recordEvent(tx, id, 'ops', 'proposal.created',
        version > 1
          ? `Revised proposal ${proposalNumber} (v${version}) is ready`
          : `Proposal ${proposalNumber} is ready — ${dto.total_credits.toLocaleString()} BC for the full period`);
      if (dto.note?.trim()) {
        await tx.q(
          `INSERT INTO pro_application_messages (application_id, sender, sender_id, body)
           VALUES ($1,'ops',$2,$3)`,
          [id, admin.user_id, dto.note.trim()],
        );
      }
      return {application: updated, proposal};
    });
    const app = result.application;
    void this.events.broadcast(id, 'proapp.status', {status: app.status}).catch(() => undefined);
    void this.push.proProposalReady(app.user_id, id).catch(() => undefined);
    return result;
  }

  async reject(admin: AdminContext, id: string, reason: string): Promise<Record<string, unknown>> {
    const app = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<ProApplicationRow>(
        `SELECT ${CLIENT_COLS} FROM pro_applications WHERE id = $1 FOR UPDATE`, [id]);
      if (!row) {throw new NotFoundException('pro_application_not_found');}
      this.fsm.assert(row.status, 'REJECTED', 'OPS_HANDLER');
      const updated = await tx.qOne<ProApplicationRow>(
        `UPDATE pro_applications
            SET status = 'REJECTED', rejected_reason = $3,
                decided_at = now(), decided_by = $4, updated_at = now()
          WHERE id = $1 AND status = $2
          RETURNING ${CLIENT_COLS}`,
        [id, row.status, reason.trim(), admin.user_id],
      );
      if (!updated) {throw new BadRequestException('pro_application_state_changed_concurrently');}
      await this.recordEvent(tx, id, 'ops', 'application.rejected', 'Application declined');
      return updated;
    });
    void this.events.broadcast(id, 'proapp.status', {status: app.status}).catch(() => undefined);
    void this.push.proApplicationRejected(app.user_id, id).catch(() => undefined);
    return {application: app};
  }

  /**
   * CLIENT withdrawal (founder spec 2026-08-04) — any pre-activation state.
   * Terminal like REJECTED; the open-slot index frees immediately so a fresh
   * application can follow. Never from ACTIVE — a paid plan only EXPIREs.
   */
  async cancel(userId: string, id: string): Promise<{application: ClientProApplication}> {
    const app = await this.db.withTransaction(async tx => {
      const row = await this.lockOwned(tx, userId, id);
      this.fsm.assert(row.status, 'CANCELLED', 'CLIENT');
      const updated = await tx.qOne<ProApplicationRow>(
        `UPDATE pro_applications
            SET status = 'CANCELLED', updated_at = now()
          WHERE id = $1 AND status = $2
          RETURNING ${CLIENT_COLS}`,
        [id, row.status],
      );
      if (!updated) {throw new BadRequestException('pro_application_state_changed_concurrently');}
      await this.recordEvent(tx, id, 'client', 'application.cancelled', 'Application cancelled by the client');
      return updated;
    });
    void this.events.broadcast(id, 'proapp.status', {status: app.status}).catch(() => undefined);
    return {application: await this.attachClientDetail(app)};
  }

  /** OPS cancel on the client's behalf — same FSM window, pushes the client. */
  async opsCancel(admin: AdminContext, id: string, note?: string): Promise<Record<string, unknown>> {
    const app = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<ProApplicationRow>(
        `SELECT ${CLIENT_COLS} FROM pro_applications WHERE id = $1 FOR UPDATE`, [id]);
      if (!row) {throw new NotFoundException('pro_application_not_found');}
      this.fsm.assert(row.status, 'CANCELLED', 'OPS_HANDLER');
      const updated = await tx.qOne<ProApplicationRow>(
        `UPDATE pro_applications
            SET status = 'CANCELLED', decided_at = now(), decided_by = $3, updated_at = now()
          WHERE id = $1 AND status = $2
          RETURNING ${CLIENT_COLS}`,
        [id, row.status, admin.user_id],
      );
      if (!updated) {throw new BadRequestException('pro_application_state_changed_concurrently');}
      await this.recordEvent(tx, id, 'ops', 'application.cancelled',
        note?.trim() ? `Application cancelled — ${note.trim()}` : 'Application cancelled by the Bravo Control System');
      return updated;
    });
    void this.events.broadcast(id, 'proapp.status', {status: app.status}).catch(() => undefined);
    void this.push.proApplicationCancelled(app.user_id, id).catch(() => undefined);
    return {application: app};
  }

  async setInternalNotes(id: string, notes: string): Promise<{ok: true}> {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE pro_applications SET internal_notes = $2, updated_at = now()
        WHERE id = $1 RETURNING id`,
      [id, notes],
    );
    if (!row) {throw new NotFoundException('pro_application_not_found');}
    return {ok: true};
  }

  async opsSendMessage(admin: AdminContext, id: string, body: string): Promise<{message: ProMessageRow}> {
    const app = await this.db.qOne<{user_id: string; status: ProApplicationStatus}>(
      `SELECT user_id, status FROM pro_applications WHERE id = $1`, [id]);
    if (!app) {throw new NotFoundException('pro_application_not_found');}
    const message = await this.db.qOne<ProMessageRow>(
      `INSERT INTO pro_application_messages (application_id, sender, sender_id, body)
       VALUES ($1,'ops',$2,$3)
       RETURNING id, sender, body, created_at`,
      [id, admin.user_id, body.trim()],
    );
    void this.events.broadcast(id, 'proapp.message', {}).catch(() => undefined);
    void this.push.proOpsMessage(app.user_id, id).catch(() => undefined);
    return {message: message!};
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async attachClientDetail(app: ProApplicationRow): Promise<ClientProApplication> {
    const proposal = await this.latestProposal(this.db, app.id);
    const events = await this.db.q<ProEventRow>(
      `SELECT id, event, actor, message, created_at FROM pro_application_events
        WHERE application_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [app.id],
    );
    // The client only sees a proposal once one is offered (never mid-draft).
    const showProposal = app.status !== 'PENDING_PROPOSAL';
    return {...app, proposal: showProposal ? proposal : null, events};
  }

  private latestProposal(tx: Tx, applicationId: string): Promise<ProProposalRow | null> {
    return tx.qOne<ProProposalRow>(
      `SELECT ${PROPOSAL_COLS} FROM pro_proposals
        WHERE application_id = $1 ORDER BY version DESC LIMIT 1`,
      [applicationId],
    );
  }

  private async lockOwned(tx: Tx, userId: string, id: string): Promise<ProApplicationRow> {
    const row = await tx.qOne<ProApplicationRow>(
      `SELECT ${CLIENT_COLS} FROM pro_applications WHERE id = $1 FOR UPDATE`, [id]);
    if (!row) {throw new NotFoundException('pro_application_not_found');}
    if (row.user_id !== userId) {throw new ForbiddenException('not_your_application');}
    return row;
  }

  private async assertOwned(userId: string, id: string): Promise<ProApplicationRow> {
    const row = await this.db.qOne<ProApplicationRow>(
      `SELECT ${CLIENT_COLS} FROM pro_applications WHERE id = $1`, [id]);
    if (!row) {throw new NotFoundException('pro_application_not_found');}
    if (row.user_id !== userId) {throw new ForbiddenException('not_your_application');}
    return row;
  }

  private async guardedStatusUpdate(
    tx: Tx, id: string, from: ProApplicationStatus, to: ProApplicationStatus,
  ): Promise<ProApplicationRow> {
    const updated = await tx.qOne<ProApplicationRow>(
      `UPDATE pro_applications SET status = $3, updated_at = now()
        WHERE id = $1 AND status = $2
        RETURNING ${CLIENT_COLS}`,
      [id, from, to],
    );
    if (!updated) {throw new BadRequestException('pro_application_state_changed_concurrently');}
    return updated;
  }

  private async recordEvent(
    tx: Tx, applicationId: string, actor: 'client' | 'ops' | 'system',
    event: string, message: string | null,
  ): Promise<void> {
    await tx.q(
      `INSERT INTO pro_application_events (application_id, actor, event, message)
       VALUES ($1,$2,$3,$4)`,
      [applicationId, actor, event, message],
    );
  }
}
