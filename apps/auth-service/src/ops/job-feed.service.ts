import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from './ops-audit.service';
import {JobStateMachine, type JobStatus} from './job-state-machine.service';
import {MissionStateMachine} from './mission-state-machine.service';
import {SystemMessengerService} from './system-messenger.service';
import type {AdminContext} from './admin.guard';
import {DEFAULT_MISSION_WAYPOINTS} from './mission-defaults';

export interface JobRow {
  id: string;
  booking_id: string;
  short_code: string;
  status: JobStatus;
  region_code: string;
  route_label: string;
  dispatch_at: Date;
  duration_hours: number;
  cpo_slots: number;
  requires_armed: boolean;
  requires_armour: string | null;
  slots_filled: number;
  published_at: Date;
  published_by: string | null;
  closed_at: Date | null;
}

export interface ApplicationRow {
  id: string;
  job_id: string;
  agent_id: string;
  agent_call_sign: string;
  status: 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN';
  rank: number | null;
  fit_score: number | null;
  distance_km: string | null;
  rate_ccy: string;
  rate_per_hour: string | null;
  applied_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  dress_pledge: string | null;
  dress_pledged_at: Date | null;
  applicant_org_id: string | null;
  assigned_cpo_user_id: string | null;
}

@Injectable()
export class JobFeedService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobFsm: JobStateMachine,
    private readonly missionFsm: MissionStateMachine,
    private readonly audit: OpsAuditService,
    private readonly systemMsg: SystemMessengerService,
  ) {}

  // ─── Publish ──────────────────────────────────────────────────────

  /**
   * Called by the booking approve flow — materialises a public job row
   * from a freshly-approved booking. Returns the new JF-XXXX short code.
   */
  async publishFromBooking(bookingId: string, admin: AdminContext): Promise<JobRow> {
    const booking = await this.db.qOne<{
      id: string; region_code: string; pickup_address: string; dropoff_address: string | null;
      pickup_time: Date; duration_hours: number; cpo_count: number;
    }>(
      `SELECT id, region_code, pickup_address, dropoff_address, pickup_time,
              duration_hours, cpo_count
         FROM lite_bookings WHERE id = $1`,
      [bookingId],
    );
    if (!booking) throw new NotFoundException('Booking not found');

    const existing = await this.db.qOne<JobRow>(
      `SELECT * FROM jobs WHERE booking_id = $1`, [bookingId],
    );
    if (existing) return existing;

    // Short code mirrors the booking suffix so a booking BL-XXXXXXXXXXXX
    // becomes job JF-XXXXXXXXXXXX, mission MSN-XXXXXXXXXXXX. Single ID
    // chain across the whole lifecycle = no mental gymnastics for ops.
    const shortCode = `JF-${bookingId.replace(/-/g, '').slice(-12).toUpperCase()}`;

    const dropoff = booking.dropoff_address ?? 'TBC';
    const routeLabel = `${booking.pickup_address.split(',')[0]} → ${dropoff.split(',')[0]}`;

    const job = await this.db.qOne<JobRow>(
      `INSERT INTO jobs
         (booking_id, short_code, status, region_code, route_label,
          dispatch_at, duration_hours, cpo_slots, published_by)
       VALUES ($1,$2,'PUBLISHED',$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        bookingId, shortCode, booking.region_code, routeLabel,
        booking.pickup_time, booking.duration_hours,
        Math.max(1, booking.cpo_count), admin.user_id,
      ],
    );
    if (!job) throw new BadRequestException('Failed to publish job');

    await this.audit.recordAdmin(admin, 'job.publish', 'job', job.id, {short_code: shortCode, booking_id: bookingId});
    await this.audit.emit({
      kind: 'job.publish', severity: 'ok', actor: admin.call_sign, subject: shortCode,
      message: `${admin.call_sign} approved ${bookingId.slice(0, 8)} · published to agent feed as ${shortCode}`,
    });
    return job;
  }

  // ─── Read ─────────────────────────────────────────────────────────

  // Why: FIFO. Ops works the queue first-in-first-out by arrival, so the
  // oldest-published job sits at the top regardless of its scheduled
  // dispatch_at. Mirrors AgentService.getAvailableJobs so the ops console
  // and the agent app present jobs in the same order.
  list(status?: JobStatus): Promise<JobRow[]> {
    if (status) {
      return this.db.q<JobRow>(
        `SELECT * FROM jobs WHERE status = $1 ORDER BY published_at ASC`,
        [status],
      );
    }
    return this.db.q<JobRow>(
      `SELECT * FROM jobs
        WHERE status <> 'CANCELLED'
        ORDER BY published_at ASC`,
    );
  }

  async getById(id: string) {
    const job = await this.db.qOne<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
    if (!job) throw new NotFoundException('Job not found');
    const applications = await this.db.q<ApplicationRow>(
      `SELECT * FROM job_applications
        WHERE job_id = $1
        ORDER BY fit_score DESC NULLS LAST, applied_at ASC`,
      [id],
    );
    return {job, applications};
  }

  // ─── Applications ─────────────────────────────────────────────────

  async apply(
    jobId: string,
    args: {agent_id: string; agent_call_sign: string; rate_per_hour?: number; rate_ccy?: string; distance_km?: number; fit_score?: number},
  ): Promise<ApplicationRow> {
    const job = await this.requireJob(jobId);
    if (!['PUBLISHED', 'REVIEW'].includes(job.status)) {
      throw new BadRequestException(`Job is ${job.status} — no longer accepting apps`);
    }
    const row = await this.db.qOne<ApplicationRow>(
      `INSERT INTO job_applications
         (job_id, agent_id, agent_call_sign, rate_per_hour, rate_ccy,
          distance_km, fit_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (job_id, agent_id) DO UPDATE
         SET rate_per_hour = EXCLUDED.rate_per_hour,
             distance_km   = EXCLUDED.distance_km,
             fit_score     = EXCLUDED.fit_score
       RETURNING *`,
      [
        jobId, args.agent_id, args.agent_call_sign,
        args.rate_per_hour ?? null, args.rate_ccy ?? 'AED',
        args.distance_km ?? null, args.fit_score ?? null,
      ],
    );
    if (!row) throw new BadRequestException('Failed to record application');
    await this.audit.record({
      actor_id: args.agent_id, actor_call: args.agent_call_sign,
      actor_role: 'AGENT', action: 'application.submit',
      subject_type: 'application', subject_id: row.id,
      metadata: {job_id: jobId, job_short: job.short_code, fit_score: args.fit_score},
    });
    await this.audit.emit({
      kind: 'application.submit', severity: 'info', actor: args.agent_call_sign,
      subject: job.short_code,
      message: `New application on job ${job.short_code} from ${args.agent_call_sign}`,
    });
    return row;
  }

  async shortlist(applicationId: string, admin: AdminContext): Promise<void> {
    const app = await this.requireApp(applicationId);
    await this.db.q(
      `UPDATE job_applications
          SET status = 'SHORTLISTED', decided_at = NOW(), decided_by = $2
        WHERE id = $1`,
      [applicationId, admin.user_id],
    );
    await this.audit.recordAdmin(admin, 'application.shortlist', 'application', applicationId, {
      job_id: app.job_id, agent: app.agent_call_sign,
    });
  }

  /** Assign a specific agent to the job. Moves job REVIEW (if PUBLISHED). */
  async assign(applicationId: string, admin: AdminContext): Promise<void> {
    const app = await this.requireApp(applicationId);
    const job = await this.requireJob(app.job_id);

    if (job.status === 'PUBLISHED') {
      this.jobFsm.assert(job.status, 'REVIEW', 'OPS');
      await this.db.q(`UPDATE jobs SET status = 'REVIEW' WHERE id = $1`, [job.id]);
    }

    await this.db.q(
      `UPDATE job_applications
          SET status = 'ASSIGNED', decided_at = NOW(), decided_by = $2
        WHERE id = $1`,
      [applicationId, admin.user_id],
    );
    await this.db.q(
      `UPDATE jobs SET slots_filled = slots_filled + 1 WHERE id = $1`, [job.id],
    );
    await this.audit.recordAdmin(admin, 'application.assign', 'application', applicationId, {
      job_id: job.id, job_short: job.short_code, agent: app.agent_call_sign,
    });

    // When all slots filled, advance job to ASSIGNED state.
    const updated = await this.db.qOne<{slots_filled: number; cpo_slots: number; status: JobStatus}>(
      `SELECT slots_filled, cpo_slots, status FROM jobs WHERE id = $1`, [job.id],
    );
    if (updated && updated.slots_filled >= updated.cpo_slots && updated.status !== 'ASSIGNED') {
      this.jobFsm.assert(updated.status, 'ASSIGNED', 'OPS');
      await this.db.q(`UPDATE jobs SET status = 'ASSIGNED' WHERE id = $1`, [job.id]);
      await this.audit.recordAdmin(admin, 'job.assigned_all_slots', 'job', job.id, {});
    }
  }

  async reject(applicationId: string, admin: AdminContext, notes?: string): Promise<void> {
    const app = await this.requireApp(applicationId);
    await this.db.q(
      `UPDATE job_applications
          SET status = 'REJECTED', decided_at = NOW(), decided_by = $2
        WHERE id = $1`,
      [applicationId, admin.user_id],
    );
    await this.audit.recordAdmin(admin, 'application.reject', 'application', applicationId, {
      job_id: app.job_id, notes,
    });
  }

  /**
   * Dispatch the job — transitions ASSIGNED → DISPATCHED and creates the
   * underlying mission row with the assigned crew, plus seeds default
   * waypoints for the UI.
   */
  async dispatch(jobId: string, admin: AdminContext): Promise<{mission_id: string}> {
    const job = await this.requireJob(jobId);
    this.jobFsm.assert(job.status, 'DISPATCHED', 'OPS');

    const assigned = await this.db.q<ApplicationRow>(
      `SELECT * FROM job_applications WHERE job_id = $1 AND status = 'ASSIGNED'`,
      [jobId],
    );
    if (assigned.length === 0) {
      throw new BadRequestException('Cannot dispatch — no crew assigned');
    }

    // Audit fix 1.7 — race-free short-code generation.
    //
    // Was: `COUNT(*) + 1` → two concurrent dispatchers both read N and
    // both write `MSN-YYYY-(N+1)`, colliding on the new unique index.
    // Fixed: derive the short code from the booking-id suffix, which
    // is unique by construction (booking_id is a UUID v4). This matches
    // the format ops.service.ts already uses for direct-dispatch flows
    // — one canonical pattern, no clock-based ordering.
    const short = `MSN-${job.booking_id.replace(/-/g, '').slice(-12).toUpperCase()}`;

    const mission = await this.db.qOne<{id: string}>(
      // LM-B1 — missions.booking_id is now a PARTIAL unique (non-ABORTED rows), so
      // the conflict target must name the index predicate to keep inferring it.
      `INSERT INTO missions (booking_id, status, short_code)
       VALUES ($1, 'DISPATCHED', $2)
       ON CONFLICT (booking_id) WHERE status <> 'ABORTED' DO UPDATE
         SET status = EXCLUDED.status
       RETURNING id`,
      [job.booking_id, short],
    );
    if (!mission) throw new BadRequestException('Failed to create mission');

    // Attach crew. The DEPLOYED OFFICER is assigned_cpo_user_id (the CPO the
    // applicant org named), NOT agent_id (which is the applicant org for org
    // applications). For legacy self-applications the two are equal (backfill),
    // so the COALESCE keeps the old behaviour. mission_crew.agent_id must be a
    // real officer — they run the mobile FSM/SOS and are the payout source.
    for (let i = 0; i < assigned.length; i++) {
      const a = assigned[i];
      const officerUserId = a.assigned_cpo_user_id ?? a.agent_id;
      // LB-OTP4 — set the `is_lead` BOOLEAN (not just the role TEXT). The client
      // verify-code endpoint resolves the lead via `WHERE mc.is_lead = TRUE`, so
      // omitting it (column default FALSE) left this legacy job-board path with no
      // lead → verify-code 400 `no_crew_assigned` forever → the client's team-code
      // card showed permanent dots. Slot 0 is the lead, matching org assignCrew.
      await this.db.q(
        `INSERT INTO mission_crew (mission_id, agent_id, slot, role, call_sign, is_lead)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [mission.id, officerUserId, i, i === 0 ? 'LEAD' : 'CP', a.agent_call_sign, i === 0],
      );
    }

    // Seed default waypoints — shared constant, see mission-defaults.ts.
    // Executive Protection missions use hourly check-ins instead of waypoints.
    const svcRow = await this.db.qOne<{service: string}>(
      `SELECT service FROM lite_bookings WHERE id = $1`, [job.booking_id],
    );
    if (svcRow?.service !== 'executive_protection') {
      for (const w of DEFAULT_MISSION_WAYPOINTS) {
        await this.db.q(
          `INSERT INTO mission_waypoints (mission_id, seq, tag, event)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [mission.id, w.seq, w.tag, w.event],
        );
      }
    }

    await this.db.q(`UPDATE jobs SET status = 'DISPATCHED' WHERE id = $1`, [jobId]);
    // B-386 — this lane is the OTHER writer of CONFIRMED; it must stamp the
    // cancel-window anchor too, or a booking confirmed here falls back to
    // created_at (the original bug).
    await this.db.q(
      `UPDATE lite_bookings SET status = 'CONFIRMED', confirmed_at = COALESCE(confirmed_at, NOW())
        WHERE id = $1`,
      [job.booking_id],
    );

    // Seed per-mission deployment checks for every crew member.
    // Ops signs these off on the mission detail page before the crew departs.
    const DEPLOY_CHECKS = ['dress', 'vehicle', 'equip', 'briefing'] as const;
    for (const a of assigned) {
      for (const check of DEPLOY_CHECKS) {
        await this.db.q(
          `INSERT INTO agent_deployment_checks
             (user_id, check_key, state, mission_id)
           VALUES ($1, $2, 'pending', $3)
           ON CONFLICT DO NOTHING`,
          [a.agent_id, check, mission.id],
        );
      }
    }

    await this.audit.recordAdmin(admin, 'job.dispatch', 'job', jobId, {
      mission_id: mission.id, mission_short: short,
    });
    await this.audit.emit({
      kind: 'mission.dispatch', severity: 'ok', actor: admin.call_sign,
      subject: short, message: `${admin.call_sign} dispatched mission ${short} (${job.short_code})`,
    });

    // Auto-create the Ops Room group conversation (client + crew + ops).
    // Best-effort — if it fails (e.g. conversation_members FK miss) the
    // dispatch itself succeeds and ops can open the comms manually.
    try {
      const clientRow = await this.db.qOne<{client_id: string}>(
        `SELECT client_id FROM lite_bookings WHERE id = $1`, [job.booking_id],
      );
      await this.systemMsg.createMissionOpsRoom({
        mission_id: mission.id,
        mission_short_code: short,
        booking_client_id: clientRow?.client_id ?? null,
        crew_user_ids: assigned.map(a => a.agent_id),
        ops_admin_user_id: admin.user_id,
      });
    } catch (e) {
      await this.audit.record({
        actor_role: 'SYSTEM', action: 'ops_room.create_failed',
        subject_type: 'mission', subject_id: mission.id,
        metadata: {error: (e as Error).message},
      });
    }

    return {mission_id: mission.id};
  }

  async cancel(jobId: string, admin: AdminContext, reason: string): Promise<void> {
    // Audit fix 1.1 — atomic state pin. Two ops admins cancelling the
    // same job concurrently could otherwise both pass the FSM check
    // and both audit-record a cancellation; the conditional UPDATE
    // makes the loser see zero rows and bail.
    await this.db.withTransaction(async tx => {
      const job = await tx.qOne<JobRow>(
        `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`, [jobId],
      );
      if (!job) throw new NotFoundException('Job not found');
      this.jobFsm.assert(job.status, 'CANCELLED', 'OPS');
      const upd = await tx.q(
        `UPDATE jobs
            SET status = 'CANCELLED', closed_at = NOW()
          WHERE id = $1 AND status = $2 RETURNING id`,
        [jobId, job.status],
      );
      if (upd.length === 0) {
        throw new BadRequestException('job_state_changed_concurrently');
      }
    });
    await this.audit.recordAdmin(admin, 'job.cancel', 'job', jobId, {reason});
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async requireJob(id: string): Promise<JobRow> {
    const row = await this.db.qOne<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('Job not found');
    return row;
  }

  private async requireApp(id: string): Promise<ApplicationRow> {
    const row = await this.db.qOne<ApplicationRow>(
      `SELECT * FROM job_applications WHERE id = $1`, [id],
    );
    if (!row) throw new NotFoundException('Application not found');
    return row;
  }
}
