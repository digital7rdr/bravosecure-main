import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {SystemMessengerService} from '../ops/system-messenger.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {DispatchRoomIntentsService} from '../dispatch/dispatch-room-intents.service';
import {DEFAULT_MISSION_WAYPOINTS} from '../ops/mission-defaults';
import {MissionStateMachine} from '../ops/mission-state-machine.service';
import type {AssignCrewDto} from './dto/org.dto';

const DEPLOY_CHECKS = ['dress', 'vehicle', 'equip', 'briefing'] as const;
// FSM defense-in-depth — a SYSTEM rollback aborting a DISPATCHED mission whose
// comms room failed. WHERE pins the from-state; the assert keeps the FSM authoritative.
const missionFsm = new MissionStateMachine();

export interface OrgMissionRow {
  booking_id: string;
  booking_status: string;
  service: string;
  region_label: string;
  pickup_time: Date;
  pickup_address: string;
  pickup_lat: string | null;
  pickup_lng: string | null;
  dropoff_address: string | null;
  dropoff_lat: string | null;
  dropoff_lng: string | null;
  cpo_count: number;
  armed_required: boolean;
  // Executive Protection — what the detail is for, its fixed block length, and whether a
  // secure-transfer leg exists. Null/irrelevant on non-executive rows.
  task_type: string | null;
  duration_hours: number;
  has_transport: boolean;
  mission_id: string | null;
  mission_status: string | null;
  short_code: string | null;
  crew: Array<{user_id: string; call_sign: string | null; role: string; is_lead: boolean}>;
}

/**
 * Agency mission board + crew assignment (BUILD_RUNBOOK Step 13) — the hand-off that
 * replaces the old admin "Dispatch" click. The agency lists its accepted jobs and crews
 * one (picking guards + a leader); that single confirm is what actually CREATES the
 * mission. All scoped to the caller's org (LB7) and race-safe (LB8); the booking stays
 * CONFIRMED through crew-assign (it leaves CONFIRMED only at lead check-in → LIVE).
 */
@Injectable()
export class OrgMissionService {
  private readonly log = new Logger(OrgMissionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly systemMsg: SystemMessengerService,
    private readonly bookingPush: BookingPushBridge,
    private readonly roomIntents: DispatchRoomIntentsService,
    private readonly config: ConfigService,
  ) {}

  /** This agency's jobs, grouped needs-crew / active / recent. Precise coords are OK —
   *  the caller is the assigned provider for every row (org-scoped in SQL, IDOR-safe). */
  async listMissions(orgUserId: string): Promise<{
    needs_crew: OrgMissionRow[]; active: OrgMissionRow[]; recent: OrgMissionRow[];
  }> {
    const rows = await this.db.q<OrgMissionRow>(
      `SELECT b.id AS booking_id, b.status AS booking_status, b.service, b.region_label,
              b.pickup_time, b.pickup_address, b.pickup_lat, b.pickup_lng,
              b.dropoff_address, b.dropoff_lat, b.dropoff_lng, b.cpo_count, b.armed_required,
              b.task_type, b.duration_hours, (b.exec_transport IS NOT NULL) AS has_transport,
              m.id AS mission_id, m.status AS mission_status, m.short_code,
              COALESCE(
                json_agg(json_build_object(
                  'user_id', mc.agent_id, 'call_sign', mc.call_sign,
                  'role', mc.role, 'is_lead', mc.is_lead) ORDER BY mc.slot)
                  FILTER (WHERE mc.agent_id IS NOT NULL),
                '[]') AS crew
         FROM lite_bookings b
         -- LM-B1: bookings can now carry ABORTED history missions besides the live
         -- one — join the SINGLE most-relevant row (active first, else newest).
         LEFT JOIN LATERAL (
           SELECT * FROM missions mm WHERE mm.booking_id = b.id
            ORDER BY (mm.status <> 'ABORTED') DESC, mm.created_at DESC LIMIT 1
         ) m ON TRUE
         LEFT JOIN mission_crew mc ON mc.mission_id = m.id
        WHERE b.assigned_provider_user_id = $1
          AND (b.status IN ('CONFIRMED', 'LIVE', 'COMPLETED', 'AGENCY_NO_SHOW')
               -- MISSION-CANCEL (#14) — a client-cancelled booking whose mission
               -- was ABORTED must appear in agency history; exclude pre-crew
               -- cancellations (no mission row) to avoid noise.
               OR (b.status = 'CANCELLED' AND m.id IS NOT NULL))
        -- m.* are LATERAL-subquery columns: Postgres only infers functional
        -- dependency from BASE-table PKs, so every selected m column must be
        -- grouped explicitly (grouping only m.id 500s: "m.status must appear
        -- in the GROUP BY clause").
        GROUP BY b.id, m.id, m.status, m.short_code
        ORDER BY b.pickup_time DESC`,
      [orgUserId],
    );
    const needs_crew: OrgMissionRow[] = [];
    const active: OrgMissionRow[] = [];
    const recent: OrgMissionRow[] = [];
    for (const r of rows) {
      if (!r.mission_id && r.booking_status === 'CONFIRMED') needs_crew.push(r);
      else if (r.mission_status && ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'].includes(r.mission_status)) active.push(r);
      else recent.push(r);
    }
    return {needs_crew, active, recent};
  }

  /**
   * MISSION-HISTORY (#3) — the agency's ALL-completed-missions list + total count
   * for the SP account, distinct from listMissions' conflated `recent` bucket.
   * Org-scoped via assigned_provider_user_id.
   */
  async listCompletedMissions(orgUserId: string, limit = 50): Promise<{completed_count: number; missions: OrgMissionRow[]}> {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    const missions = await this.db.q<OrgMissionRow>(
      `SELECT b.id AS booking_id, b.status AS booking_status, b.service, b.region_label,
              b.pickup_time, b.pickup_address, b.pickup_lat, b.pickup_lng,
              b.dropoff_address, b.dropoff_lat, b.dropoff_lng, b.cpo_count, b.armed_required,
              b.task_type, b.duration_hours, (b.exec_transport IS NOT NULL) AS has_transport,
              m.id AS mission_id, m.status AS mission_status, m.short_code,
              COALESCE(
                json_agg(json_build_object(
                  'user_id', mc.agent_id, 'call_sign', mc.call_sign,
                  'role', mc.role, 'is_lead', mc.is_lead) ORDER BY mc.slot)
                  FILTER (WHERE mc.agent_id IS NOT NULL),
                '[]') AS crew
         FROM lite_bookings b
         -- ≤1 COMPLETED mission per booking (missions_booking_active_uq covers all
         -- non-ABORTED rows), so this join stays 1:1 under LM-B1's history rows.
         JOIN missions m ON m.booking_id = b.id
         LEFT JOIN mission_crew mc ON mc.mission_id = m.id
        WHERE b.assigned_provider_user_id = $1 AND m.status = 'COMPLETED'
        GROUP BY b.id, m.id
        ORDER BY m.ended_at DESC NULLS LAST, b.pickup_time DESC
        LIMIT $2`,
      [orgUserId, safeLimit],
    );
    const c = await this.db.qOne<{n: string}>(
      `SELECT count(*)::text AS n FROM missions m
         JOIN lite_bookings b ON b.id = m.booking_id
        WHERE b.assigned_provider_user_id = $1 AND m.status = 'COMPLETED'`,
      [orgUserId],
    );
    return {completed_count: Number(c?.n ?? 0), missions};
  }

  /**
   * SP-MISSION-DETAIL (#2nd · Decision §3) — the agency's view of a mission's
   * escrow: payout figure + hold status only, NEVER the client's wallet internals
   * (to_client_credits is deliberately omitted). Org-scoped — the booking's
   * assigned_provider_user_id must equal the caller's org (the IDOR close).
   * Returns null when the org owns the booking but it carries no escrow hold
   * (a legacy / non-escrow booking).
   */
  async getMissionEscrow(orgUserId: string, bookingId: string): Promise<{
    status: string; basis: string | null; currency: string | null;
    gross_credits: number; to_provider_credits: number | null; platform_fee_credits: number | null;
  } | null> {
    const row = await this.db.qOne<{
      status: string; basis: string | null; currency: string | null;
      gross_credits: number; to_provider_credits: number | null; platform_fee_credits: number | null;
    }>(
      `SELECT eh.status, eh.basis, eh.currency, eh.gross_credits,
              eh.to_provider_credits, eh.platform_fee_credits
         FROM escrow_holds eh
         JOIN lite_bookings b ON b.id = eh.booking_id
        WHERE eh.booking_id = $1 AND b.assigned_provider_user_id = $2`,
      [bookingId, orgUserId],
    );
    if (row) {return row;}
    // No hold joined under the org gate — distinguish "not your booking" (IDOR)
    // from "your booking, no escrow" (legacy) so a foreign booking never leaks.
    const owns = await this.db.qOne<{ok: number}>(
      `SELECT 1 AS ok FROM lite_bookings WHERE id = $1 AND assigned_provider_user_id = $2`,
      [bookingId, orgUserId],
    );
    if (!owns) {throw new ForbiddenException('not_your_booking');}
    return null;
  }

  /**
   * Step 32 — one mission's live positions for the org's desk monitor. Org-scoped
   * (the booking's assigned_provider_user_id must match the caller's org) so a
   * manager can only ever watch their OWN deployments — the same tenant gate
   * listMissions uses. Returns the SAME shape as the crew-gated agent deployment
   * read so the live tracker consumes it unchanged, INCLUDING the principal's
   * last-known GPS (client_lat/lng) so the map draws BOTH the CPO leader and the
   * user. Precise coords are intentional here: the caller is the owning provider.
   */
  async getMissionLive(orgUserId: string, missionId: string) {
    const mission = await this.db.qOne<{
      short_code: string; status: string; booking_id: string;
      route_distance_m: number | null; route_duration_s: number | null;
      route_polyline: string | null;
      current_lat: number | null; current_lng: number | null;
      current_heading_deg: number | null;
      client_lat: number | null; client_lng: number | null;
      client_recorded_at: Date | null;
      comms_channel_id: string | null;
      pickup_at: Date | null; live_at: Date | null;
    }>(
      // B-89 MG-02 — same omission as the crew deployment read: heading was
      // written but never selected, so the monitor view's cone never rotated.
      // C-8 — pickup_at/live_at complete the promised MissionDeploymentResponse
      // shape (the agent read has them; a manager-mode hourly clock silently got
      // undefined here).
      `SELECT m.short_code, m.status, m.booking_id,
              m.route_distance_m, m.route_duration_s, m.route_polyline,
              m.current_lat, m.current_lng,
              m.heading_deg AS current_heading_deg,
              m.client_lat, m.client_lng, m.client_recorded_at,
              m.comms_channel_id, m.pickup_at, m.live_at
         FROM missions m
         JOIN lite_bookings b ON b.id = m.booking_id
        WHERE m.id = $1 AND b.assigned_provider_user_id = $2`,
      [missionId, orgUserId],
    );
    // Null = either the mission doesn't exist OR it isn't this org's — closed IDOR.
    if (!mission) {
      throw new ForbiddenException('not_your_org_mission');
    }

    const [booking, waypoints, crewList, hourlyCheckins] = await Promise.all([
      this.db.qOne<{
        pickup_address: string; pickup_lat: string | null; pickup_lng: string | null;
        dropoff_address: string | null; dropoff_lat: string | null; dropoff_lng: string | null;
        booking_status: string; client_name: string | null;
        service: string; task_type: string | null; duration_hours: number;
        notes: string | null; exec_transport: unknown | null;
      }>(
        // The agency plans the drive: for executive it needs the actual transfer
        // legs + the client's brief, not just the presence flag.
        `SELECT b.pickup_address, b.pickup_lat, b.pickup_lng,
                b.dropoff_address, b.dropoff_lat, b.dropoff_lng,
                b.status AS booking_status, u.display_name AS client_name,
                b.service, b.task_type, b.duration_hours,
                b.notes, b.exec_transport
           FROM lite_bookings b
           LEFT JOIN public.users u ON u.id = b.client_id
          WHERE b.id = $1`,
        [mission.booking_id],
      ),
      this.db.q<{seq: number; tag: string; event: string; state: string; settled_at: Date | null; marked_via: string | null}>(
        `SELECT seq, tag, event, state, settled_at, marked_via
           FROM mission_waypoints WHERE mission_id = $1 ORDER BY seq`,
        [missionId],
      ),
      this.db.q<{call_sign: string | null; role: string; team_idx: number; is_lead: boolean; is_me: boolean}>(
        `SELECT call_sign, role, team_idx, is_lead, false AS is_me
           FROM mission_crew
          WHERE mission_id = $1 AND status <> 'off'
          ORDER BY is_lead DESC, team_idx`,
        [missionId],
      ),
      // Executive Protection — hourly timeline for the monitor view (empty for non-executive).
      this.db.q<{hour_index: number; status: string; comment: string | null; created_at: Date}>(
        `SELECT hour_index, status, comment, created_at
           FROM mission_hourly_checkins
          WHERE mission_id = $1
          ORDER BY hour_index`,
        [missionId],
      ),
    ]);

    // The CPO marker label shows the lead's call sign for the manager's view.
    const lead = crewList.find(c => c.is_lead) ?? crewList[0] ?? null;
    return {
      checks: [] as Array<{check_key: string; state: string; notes: string | null; signed_at: string | null}>,
      mission: {
        ...mission,
        client_recorded_at: mission.client_recorded_at?.toISOString() ?? null,
        pickup_at: mission.pickup_at?.toISOString?.() ?? (mission.pickup_at as unknown as string | null),
        live_at: mission.live_at?.toISOString?.() ?? (mission.live_at as unknown as string | null),
      },
      crew_role: lead
        ? {is_lead: true, team_idx: lead.team_idx, role: lead.role, call_sign: lead.call_sign ?? 'LEAD'}
        : null,
      dress_instructions: null as string | null,
      dress_acknowledged_at: null as string | null,
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
   * F6 — the agency earnings roll-up: totals + one row per settled/settling
   * escrow hold. Org-scoped via assigned_provider_user_id; amounts come from
   * the escrow split columns (the money that actually moved), never recomputed.
   */
  async getEarnings(orgUserId: string): Promise<{
    total_missions: number;
    total_gross_credits: number;
    total_fee_credits: number;
    total_net_credits: number;
    pending_credits: number;
    rows: Array<{
      booking_id: string; short_code: string | null; service: string;
      region_label: string; ended_at: string | null; hold_status: string;
      gross_credits: number; platform_fee_credits: number | null; to_provider_credits: number | null;
    }>;
  }> {
    const rows = await this.db.q<{
      booking_id: string; short_code: string | null; service: string;
      region_label: string; ended_at: Date | null; hold_status: string;
      gross_credits: number; platform_fee_credits: number | null; to_provider_credits: number | null;
    }>(
      `SELECT eh.booking_id, m.short_code, b.service, b.region_label,
              m.ended_at, eh.status AS hold_status,
              eh.gross_credits, eh.platform_fee_credits, eh.to_provider_credits
         FROM escrow_holds eh
         JOIN lite_bookings b ON b.id = eh.booking_id
         LEFT JOIN missions m ON m.booking_id = eh.booking_id AND m.status <> 'ABORTED'
        WHERE eh.provider_user_id = $1
          AND eh.status IN ('PENDING_RELEASE', 'RELEASED', 'PARTIAL', 'DISPUTED')
        ORDER BY COALESCE(m.ended_at, b.pickup_time) DESC
        LIMIT 200`,
      [orgUserId],
    );
    let gross = 0, fee = 0, net = 0, pending = 0, missions = 0;
    for (const r of rows) {
      missions++;
      if (r.hold_status === 'RELEASED' || r.hold_status === 'PARTIAL') {
        gross += r.gross_credits;
        fee += r.platform_fee_credits ?? 0;
        net += r.to_provider_credits ?? 0;
      } else {
        pending += r.gross_credits;
      }
    }
    return {
      total_missions: missions,
      total_gross_credits: gross,
      total_fee_credits: fee,
      total_net_credits: net,
      pending_credits: pending,
      rows: rows.map(r => ({...r, ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null})),
    };
  }

  /**
   * Crew a CONFIRMED, not-yet-crewed booking: validate (same-org + free + lead-in-crew +
   * count==cpo_count + armed) and create the mission + crew + waypoints + deployment
   * checks in ONE race-safe transaction (LB7/LB8/LB11). Then (best-effort, post-commit)
   * open the agency-owned Ops Room and enqueue a Step-12 add-intent per CPO so the agency
   * device rekeys them in, and wake each CPO's phone.
   *
   * LM-B1 — the tenant gate ignores ABORTED missions (an arrival no-show re-dispatch
   * leaves one behind as history; the partial unique missions_booking_active_uq allows
   * a fresh ACTIVE mission alongside it), so a replacement agency can crew the booking.
   * LM-B5 — a double-confirm with the SAME crew returns the existing mission (200);
   * a different crew 409s with `crew_already_assigned` (crew editing is a separate
   * endpoint); anything else 409s `booking_not_assignable`.
   */
  async assignCrew(
    orgUserId: string, requestedBy: string, bookingId: string, dto: AssignCrewDto,
  ): Promise<{ok: true; mission_id: string; short_code: string; crew: number; lead_user_id: string}> {
    const cpoIds = Array.from(new Set(dto.cpo_user_ids));
    if (!cpoIds.includes(dto.lead_user_id)) throw new BadRequestException('lead_not_in_crew');

    // Step 16 — the arrival clock starts at crew-assign: the assigned crew must reach
    // PICKUP within arrivalSlaMinutes, else the arrival-no-show watchdog re-dispatches
    // the booking. Stamped on the same row-lock UPDATE that gates the assign.
    const arrivalSla = this.config.get<number>('dispatch.arrivalSlaMinutes') ?? 20;
    const fresh = await this.db.withTransaction(async tx => {
      // 1) Tenant + state gate (LB7 org-by-row + LB8 conditional). The no-op status flip
      //    takes the row lock; RETURNING yields the row only if all conditions hold.
      const booking = await tx.qOne<{
        id: string; cpo_count: number; armed_required: boolean;
        requirements: Record<string, unknown>; region_code: string;
        client_id: string; conversation_id: string | null; assigned_provider_user_id: string;
        service: string;
      }>(
        `UPDATE lite_bookings
            SET status = 'CONFIRMED',
                arrival_deadline_at = NOW() + ($3 || ' minutes')::interval
          WHERE id = $1 AND assigned_provider_user_id = $2 AND status = 'CONFIRMED'
            AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.booking_id = $1 AND m.status <> 'ABORTED')
        RETURNING id, cpo_count, armed_required, requirements, region_code,
                  client_id, conversation_id, assigned_provider_user_id, service`,
        [bookingId, orgUserId, arrivalSla],
      );
      if (!booking) return null; // not a fresh assign — resume/409 decided after the txn

      // 2) Validate the crew (LB11).
      if (cpoIds.length !== booking.cpo_count) throw new ConflictException('crew_count_mismatch');

      // LM-V2 — member_role='cpo' only: a manager account must not be crewable (it
      // isn't counted by has_free_cpo_capacity, so crewing one desyncs capacity).
      const members = await tx.q<{member_user_id: string; call_sign: string | null; agent_status: string | null; on_duty: boolean | null}>(
        `SELECT om.member_user_id, om.call_sign, a.status AS agent_status, a.on_duty
           FROM org_members om
           LEFT JOIN agents a ON a.user_id = om.member_user_id
          WHERE om.org_user_id = $1 AND om.member_user_id = ANY($2)
            AND om.status = 'active' AND om.member_role = 'cpo'`,
        [orgUserId, cpoIds],
      );
      if (members.length !== cpoIds.length) throw new BadRequestException('cpo_not_in_org');
      for (const m of members) {
        if (m.agent_status !== 'ACTIVE' && m.agent_status !== 'APPROVED') {
          throw new BadRequestException('cpo_not_approved_for_deployment');
        }
        // B-202 — an off-duty guard is not available: they must not be crewed
        // even if the client somehow submits them (a stale sheet, a duty toggle
        // that flipped after the sheet opened). The client hides them too.
        if (!m.on_duty) {
          throw new BadRequestException('cpo_not_on_duty');
        }
      }
      const callSignOf = new Map(members.map(m => [m.member_user_id, m.call_sign]));

      // Free: no CPO already on a non-terminal mission crew (the DB unique index
      // mission_crew_agent_active_uq is the race backstop, caught as 23505 below).
      const busy = await tx.q<{agent_id: string}>(
        `SELECT mc.agent_id FROM mission_crew mc
           JOIN missions m ON m.id = mc.mission_id
          WHERE mc.agent_id = ANY($1) AND mc.status <> 'off'
            AND m.status NOT IN ('COMPLETED', 'ABORTED')`,
        [cpoIds],
      );
      if (busy.length > 0) throw new ConflictException('cpo_busy');

      // Armed (LB11): every CPO must hold a valid regional armed authorization.
      // ⚠️ female/medical flags ride in requirements but have NO authoritative per-CPO
      // column yet (gap) — only `armed` is enforceable here; female/medical await a
      // per-CPO capability column + migration before they can be validated.
      if (booking.armed_required) {
        const armed = await tx.q<{cpo_user_id: string}>(
          `SELECT cpo_user_id FROM armed_authorizations
            WHERE cpo_user_id = ANY($1) AND region_code = $2
              AND authorized AND (expires_at IS NULL OR expires_at > NOW())`,
          [cpoIds, booking.region_code],
        );
        if (armed.length !== cpoIds.length) throw new ConflictException('requirement_unmet_armed');
      }

      // 3) Create mission + crew + waypoints + deployment checks (reuse the dispatch() shape).
      // LM-B1 — short_code is UNIQUE (missions_short_code_uq) and derived from the
      // booking id, so a re-crew after an arrival no-show (ABORTED history row keeps
      // the base code) needs an attempt suffix to stay collision-free.
      const priorRow = await tx.qOne<{n: string}>(
        `SELECT count(*)::text AS n FROM missions WHERE booking_id = $1`,
        [bookingId],
      );
      const attempt = Number(priorRow?.n ?? '0') + 1;
      const base = `MSN-${bookingId.replace(/-/g, '').slice(-12).toUpperCase()}`;
      const short = attempt === 1 ? base : `${base}-R${attempt}`;
      // Partial-index conflict target (missions_booking_active_uq): a concurrent
      // assign that slipped past the gate must NOT merge two crews into one mission —
      // DO NOTHING makes the loser fail cleanly below.
      const mission = await tx.qOne<{id: string}>(
        `INSERT INTO missions (booking_id, status, short_code)
         VALUES ($1, 'DISPATCHED', $2)
         ON CONFLICT (booking_id) WHERE status <> 'ABORTED' DO NOTHING
         RETURNING id`,
        [bookingId, short],
      );
      if (!mission) throw new ConflictException('booking_not_assignable');

      // Lead first (slot 0), so role='LEAD'/is_lead=true sit at slot 0 like the legacy path.
      const ordered = [dto.lead_user_id, ...cpoIds.filter(id => id !== dto.lead_user_id)];
      for (let i = 0; i < ordered.length; i++) {
        const cpo = ordered[i];
        const callSign = callSignOf.get(cpo)?.trim() || `ORG-${orgUserId.slice(0, 4).toUpperCase()}`;
        try {
          await tx.q(
            `INSERT INTO mission_crew (mission_id, agent_id, slot, role, call_sign, is_lead, team_idx, armed)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
             ON CONFLICT (mission_id, agent_id) DO NOTHING`,
            [mission.id, cpo, i, i === 0 ? 'LEAD' : 'CP', callSign, i === 0, booking.armed_required],
          );
        } catch (e) {
          // mission_crew_agent_active_uq (agent_id WHERE status<>'off') — the CPO is on
          // another live mission (lost a race against has_free_cpo_capacity).
          if (/duplicate key|23505/i.test((e as Error).message)) throw new ConflictException('cpo_busy');
          throw e;
        }
      }
      // Executive Protection missions have NO waypoint/checkpoint timeline — the lead
      // confirms each elapsed hour instead (mission_hourly_checkins). Deploy
      // checks (dress/vehicle/equip/briefing) still apply: they gate PICKUP
      // readiness, which is product-independent.
      if (booking.service !== 'executive_protection') {
        for (const w of DEFAULT_MISSION_WAYPOINTS) {
          await tx.q(
            `INSERT INTO mission_waypoints (mission_id, seq, tag, event)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [mission.id, w.seq, w.tag, w.event],
          );
        }
      }
      for (const cpo of cpoIds) {
        for (const check of DEPLOY_CHECKS) {
          await tx.q(
            `INSERT INTO agent_deployment_checks (user_id, check_key, state, mission_id)
             VALUES ($1, $2, 'pending', $3) ON CONFLICT DO NOTHING`,
            [cpo, check, mission.id],
          );
        }
      }
      return {missionId: mission.id, short, clientId: booking.client_id, provider: booking.assigned_provider_user_id, crewIds: ordered};
    });

    // 4) Not a fresh assign — decide resume vs conflict (LM-B5). A live (non-ABORTED)
    // mission of THIS org with the SAME crew+lead is an idempotent double-confirm:
    // return it (and re-drive the best-effort room/intents below, which also covers a
    // prior assign that crashed between the txn commit and the Ops-Room/intents step).
    // A different crew is a real conflict (crew editing is its own endpoint).
    let result = fresh;
    if (!result) {
      const resume = await this.db.qOne<{mission_id: string; short_code: string; client_id: string; assigned_provider_user_id: string}>(
        `SELECT m.id AS mission_id, m.short_code, b.client_id, b.assigned_provider_user_id
           FROM lite_bookings b JOIN missions m ON m.booking_id = b.id AND m.status <> 'ABORTED'
          WHERE b.id = $1 AND b.assigned_provider_user_id = $2`,
        [bookingId, orgUserId],
      );
      if (!resume) throw new ConflictException('booking_not_assignable');
      const crew = await this.db.q<{agent_id: string; is_lead: boolean}>(
        `SELECT agent_id, is_lead FROM mission_crew WHERE mission_id = $1`, [resume.mission_id]);
      const existingIds = new Set(crew.map(c => c.agent_id));
      const existingLead = crew.find(c => c.is_lead)?.agent_id ?? null;
      const sameCrew = existingIds.size === cpoIds.length
        && cpoIds.every(id => existingIds.has(id))
        && existingLead === dto.lead_user_id;
      if (!sameCrew) throw new ConflictException('crew_already_assigned');
      result = {
        missionId: resume.mission_id, short: resume.short_code, clientId: resume.client_id,
        provider: resume.assigned_provider_user_id, crewIds: crew.map(c => c.agent_id),
      };
    }
    const crewIds = result.crewIds;

    // 5) Open the agency-owned Ops Room + enqueue Step-12 add-intents + wake each CPO.
    // Best-effort + IDEMPOTENT (createMissionOpsRoom returns the existing room; enqueue
    // skips an already-pending/done intent) — safe to re-run on a resume. E2EE: the AGENCY
    // is the room creator/admin (holds the group key) — never SYSTEM; the CPOs are NOT added
    // as metadata members here, they are rekeyed in by the agency device draining the
    // add-intents (the server distributes no key).
    try {
      const room = await this.systemMsg.createMissionOpsRoom({
        mission_id: result.missionId,
        mission_short_code: result.short,
        booking_client_id: result.clientId,
        crew_user_ids: [],
        ops_admin_user_id: result.provider,
        creator_user_id: result.provider,
      });
      await this.db.q(
        `UPDATE lite_bookings SET conversation_id = $2 WHERE id = $1 AND conversation_id IS NULL`,
        [bookingId, room.conversation_id],
      );
      // The CLIENT, the assigned crew AND the org's managers all belong in the
      // Ops Room. The owner (agency) is already in it — on this path the agency
      // COMPANY account is the room creator/admin, and org id == company user id.
      //
      // Two halves, both required: the metadata row (below) is what
      // `listMine` joins on, so without it the room is invisible to the member
      // and MessengerHomeScreen's reconciliation sweep DELETES the locally
      // bootstrapped copy off their device; the add-intent is what makes the
      // agency device distribute the group key. Seating without the intent
      // shows an undecryptable room, the intent without seating shows nothing.
      //
      // B-207 — the CLIENT was previously excluded here: `createMissionOpsRoom`
      // seats the client only on FIRST creation (and short-circuits on an
      // existing comms_channel_id), and its key came from a ONE-SHOT create
      // fan-out that is never re-sent. On a resume, a crash between create and
      // seating, or a client offline past the fan-out, the client saw nothing.
      // Seating the client here (idempotent) restores visibility on every
      // crew-assign, and enqueuing its add-intent gives it the same at-least-once
      // retried key path every crew/manager already has (the drain benign-acks
      // an already-member client, so it never churns).
      const managers = await this.db.q<{member_user_id: string}>(
        `SELECT member_user_id FROM org_members
          WHERE org_user_id = $1 AND status = 'active' AND member_role = 'manager'`,
        [orgUserId],
      );
      // B-416 — the PROVIDER (agency owner) is now seated + intented too.
      // The metadata seat is already there (createMissionOpsRoom seats the
      // creator as admin) so re-seating is a no-op; what was missing was the
      // KEY intent. Under claimed key authority the bootstrapper can be a
      // MANAGER's device, and without an owner add-intent a manager-claimed
      // room would leave the owner permanently keyless in its own mission
      // room. On owner-claimed rooms the owner's own add-intent hits the
      // drain's cannot-add-self benign-ack — no churn.
      const roomMembers = Array.from(new Set([
        result.clientId,
        result.provider,
        ...crewIds,
        ...managers.map(m => m.member_user_id),
      ])).filter(id => !!id);
      await this.systemMsg.ensureRoomMembers(room.conversation_id, roomMembers);
      for (const uid of roomMembers) {
        await this.roomIntents.enqueueRoomIntent(orgUserId, bookingId, room.conversation_id, uid, 'add', requestedBy);
      }
    } catch (e) {
      // Issue 11 — this catch used to swallow at WARN. When it fired, the
      // mission was already inserted and DISPATCHED by step 3, so the crew
      // assign reported success while the mission had NO comms room: the mobile
      // mission chat had nothing to open and the console answered
      // `conversation_not_found_or_forbidden`. Silent, and invisible until a
      // human noticed mid-mission.
      //
      // The failure is LOUD and RECORDED either way: ERROR level, plus a
      // comms_room_failed_at marker so ops can query which missions are talking
      // to nobody.
      this.log.error(
        `ops-room setup FAILED for booking ${bookingId} (mission ${result.missionId}): ${(e as Error).message}`,
      );
      await this.db
        .q(
          `UPDATE missions SET comms_room_failed_at = NOW() WHERE id = $1`,
          [result.missionId],
        )
        .catch(() => undefined);

      // Issue 11, second half — "mission activation must fail SAFELY if the
      // communication room cannot be created" (PDF p.16).
      //
      // On a FRESH assign the mission only exists because of this call, so the
      // safe outcome is that it does not survive: roll it back and tell the
      // agency the assign failed. `fresh` is the discriminator — on a RESUME
      // the mission predates this call and may already be picked up or live, so
      // aborting it would be far worse than a missing room; that path keeps the
      // marker and returns 200, and re-running assignCrew with the same crew
      // re-drives the room (the repair path).
      //
      // Rollback is the SAME primitive the arrival-no-show sweep uses, and it
      // works because both partial uniques are status-scoped:
      // missions_booking_active_uq covers `status <> 'ABORTED'`, so an ABORTED
      // row frees the booking to be crewed again, and
      // mission_crew_agent_active_uq covers `status <> 'off'`, so standing the
      // crew down frees every CPO. Without the crew stand-down those officers
      // would be "busy" forever — the mission-drift-janitor class of bug.
      //
      // Escrow is deliberately untouched: the hold belongs to the booking and
      // is carried to the retry, exactly as the no-show re-dispatch leaves it.
      if (fresh) {
        await this.rollbackFailedActivation(bookingId, result.missionId);
        throw new ServiceUnavailableException('comms_room_unavailable');
      }
    }
    for (const cpo of crewIds) {
      void this.bookingPush?.missionDispatched(cpo, result.missionId, bookingId);
    }
    // LM-N4 — the client previously learned about crew-assign only via the 5s poll;
    // wake them ("your detail is being prepared").
    void this.bookingPush?.crewAssigned(result.clientId, bookingId);

    return {ok: true, mission_id: result.missionId, short_code: result.short, crew: crewIds.length, lead_user_id: dto.lead_user_id};
  }

  /**
   * Issue 11 — undo a just-created mission whose Ops Room could not be opened,
   * so the booking returns to the agency's needs-crew list instead of going out
   * with no comms. Best-effort by design: if the rollback itself fails the
   * caller still throws, and the comms_room_failed_at marker written by the
   * caller is what ops queries to find the wreckage.
   */
  private async rollbackFailedActivation(bookingId: string, missionId: string): Promise<void> {
    try {
      await this.db.withTransaction(async tx => {
        // Only a mission still sitting at DISPATCHED may be rolled back — if a
        // lead raced us to PICKUP the deployment is real and must stand.
        missionFsm.assert('DISPATCHED', 'ABORTED', 'SYSTEM');
        const aborted = await tx.q(
          `UPDATE missions SET status = 'ABORTED', ended_at = NOW(),
                  end_reason = COALESCE(end_reason, 'comms_room_unavailable')
            WHERE id = $1 AND status = 'DISPATCHED' AND pickup_at IS NULL
            RETURNING id`,
          [missionId],
        );
        if (aborted.length === 0) {
          return;
        }
        await tx.q(
          `UPDATE mission_crew SET status = 'off' WHERE mission_id = $1 AND status <> 'off'`,
          [missionId],
        );
        // The arrival clock started on the assign that just failed; nobody is
        // travelling, so clear it or the no-show sweep re-dispatches a booking
        // the agency is about to retry.
        await tx.q(
          `UPDATE lite_bookings SET arrival_deadline_at = NULL WHERE id = $1`,
          [bookingId],
        );
      });
    } catch (e) {
      this.log.error(
        `rollback of failed activation for mission ${missionId} FAILED — ` +
        `booking ${bookingId} may hold a dispatched mission with no comms room: ${(e as Error).message}`,
      );
    }
  }
}
