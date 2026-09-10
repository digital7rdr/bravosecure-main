import {BadRequestException, Injectable, Logger, NotFoundException, Optional} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from './ops-audit.service';
import {SystemMessengerService} from './system-messenger.service';
import {MapboxDirectionsService} from './mapbox-directions.service';
import {MissionStateMachine, type MissionStatus, type MissionActor} from './mission-state-machine.service';
import {MissionEventsService} from './mission-events.service';
import {BookingPushBridge} from './booking-push-bridge.service';
import {WalletService} from '../wallet/wallet.service';
import {assertRegionScope} from './admin.guard';
import type {AdminContext} from './admin.guard';

export interface MissionRow {
  id: string;
  booking_id: string;
  status: MissionStatus;
  short_code: string;
  started_at: Date;
  ended_at: Date | null;
  ended_by: string | null;
  end_reason: string | null;
  current_lat: number | null;
  current_lng: number | null;
  heading_deg: number | null;
  speed_kph: number | null;
  client_lat: number | null;
  client_lng: number | null;
  client_recorded_at: Date | null;
  /** B-89 MG-15 — bumped on every telemetry push; ops uses it for lost-signal staleness. */
  updated_at: Date | null;
  risk_level: string;
  comms_pct: number;
  gps_rtk_lock: boolean;
  vehicle_model: string | null;
  vehicle_plate: string | null;
  vehicle_armour: string | null;
  comms_channel_id: string | null;
}

export interface SosRow {
  id: string;
  mission_id: string;
  agent_id: string | null;
  agent_call_sign: string | null;
  reason: string;
  lat: number | null;
  lng: number | null;
  triggered_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  escalated_at: Date | null;
  escalated_to: string | null;
  resolved_at: Date | null;
  resolution: string | null;
}

@Injectable()
export class MissionService {
  private readonly log = new Logger(MissionService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly fsm: MissionStateMachine,
    private readonly audit: OpsAuditService,
    private readonly systemMsg: SystemMessengerService,
    private readonly mapbox: MapboxDirectionsService,
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
    // Audit fix 5.1 — pub/sub bridge to messenger-service so clients
    // subscribed to mission:<id> receive lifecycle frames instead of
    // polling. Optional in the spec but the AppModule wires it.
    @Optional() private readonly events?: MissionEventsService,
    // Optional FCM bridge for agent-side wakes (abort, SOS fanout, etc.).
    @Optional() private readonly bookingPush?: BookingPushBridge,
  ) {}

  /**
   * Post a system card into the mission's Ops Room (if one exists).
   * Best-effort — never throws.
   */
  private async postToOpsRoom(
    mission: {id: string; short_code: string; comms_channel_id: string | null},
    kind:
      | 'mission_pickup' | 'mission_live'
      | 'mission_sos' | 'mission_sos_ack' | 'mission_sos_resolved'
      | 'mission_abort' | 'mission_complete',
    message: string,
    severity?: 'info' | 'ok' | 'warn' | 'err',
    by?: string,
  ): Promise<void> {
    if (!mission.comms_channel_id) return;
    try {
      await this.systemMsg.sendMissionEvent({
        conversation_id:    mission.comms_channel_id,
        mission_id:         mission.id,
        mission_short_code: mission.short_code,
        kind, message, severity, by,
      });
    } catch (e) {
      // swallow — audit already captures the mission event
      void e;
    }
  }

  // ─── Read ─────────────────────────────────────────────────────────

  listActive(region?: string): Promise<(MissionRow & {
    client_id: string | null;
    client_display_name: string | null;
    client_email: string | null;
    pickup_address: string | null;
    dropoff_address: string | null;
    region_code: string | null;
    region_label: string | null;
    route_distance_m: number | null;
    route_duration_s: number | null;
    route_polyline: string | null;
  })[]> {
    return this.listByStatus(['DISPATCHED','PICKUP','LIVE','SOS'], region, undefined);
  }

  /**
   * Closed-mission feed for the ops console "Completed" tab. Capped at
   * 50 rows by default so the panel stays light; the filter param lets
   * the UI swap regions cheaply. ABORTED rolls in alongside COMPLETED
   * so the admin sees the full closed-history picture in one place.
   */
  listClosed(region?: string, limit = 50) {
    return this.listByStatus(['COMPLETED','ABORTED'], region, limit);
  }

  private listByStatus(
    statuses: string[],
    region: string | undefined,
    limit: number | undefined,
  ): Promise<(MissionRow & {
    client_id: string | null;
    client_display_name: string | null;
    client_email: string | null;
    pickup_address: string | null;
    dropoff_address: string | null;
    region_code: string | null;
    region_label: string | null;
    route_distance_m: number | null;
    route_duration_s: number | null;
    route_polyline: string | null;
  })[]> {
    const cols = `m.*,
            b.client_id, b.region_code, b.region_label,
            b.pickup_address, b.dropoff_address,
            u.display_name AS client_display_name,
            u.email AS client_email`;
    const params: unknown[] = [statuses];
    let sql =
      `SELECT ${cols}
         FROM missions m
         JOIN lite_bookings b ON b.id = m.booking_id
         LEFT JOIN users u ON u.id = b.client_id
        WHERE m.status = ANY($1)`;
    if (region) {
      params.push(region);
      sql += ` AND b.region_code = $${params.length}`;
    }
    sql += ` ORDER BY COALESCE(m.ended_at, m.started_at) DESC`;
    if (limit) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }
    return this.db.q(sql, params);
  }

  async getById(id: string, admin: AdminContext) {
    const mission = await this.db.qOne<MissionRow>(
      `SELECT * FROM missions WHERE id = $1`, [id],
    );
    if (!mission) throw new NotFoundException('Mission not found');
    // Audit AUTH-01 — enforce region scope on this by-id read (was
    // unscoped, letting a region-scoped admin read any tenant's mission +
    // customer PII by UUID). Mutations already do this via assertMissionRegion.
    await this.assertMissionRegion(admin, mission.booking_id);
    const [crew, waypoints, principals, sos, audit, booking, vehicle, hourlyCheckins] = await Promise.all([
      this.db.q(`SELECT * FROM mission_crew WHERE mission_id = $1 ORDER BY slot`, [id]),
      this.db.q(`SELECT * FROM mission_waypoints WHERE mission_id = $1 ORDER BY seq`, [id]),
      this.db.q(`SELECT * FROM mission_principals WHERE mission_id = $1 ORDER BY order_idx`, [id]),
      this.db.q(
        `SELECT * FROM sos_events WHERE mission_id = $1 ORDER BY triggered_at DESC`,
        [id],
      ),
      this.audit.listForSubject('mission', id, 20),
      this.db.qOne<{
        id: string; client_id: string; pickup_address: string;
        pickup_lat: string | null; pickup_lng: string | null;
        dropoff_address: string | null;
        dropoff_lat: string | null; dropoff_lng: string | null;
        region_code: string; region_label: string;
        service: string; pickup_time: Date;
        cpo_count: number; vehicle_count: number; total_eur: string; total_aed: string;
        dress_instructions: string | null;
        task_type: string | null; duration_hours: number; exec_transport: unknown | null;
        client_display_name: string | null; client_email: string | null; client_phone: string | null;
      }>(
        `SELECT b.id, b.client_id, b.pickup_address, b.pickup_lat, b.pickup_lng,
                b.dropoff_address, b.dropoff_lat, b.dropoff_lng,
                b.region_code, b.region_label, b.service, b.pickup_time,
                b.cpo_count, b.vehicle_count, b.total_eur, b.total_aed,
                b.dress_instructions,
                b.task_type, b.duration_hours, b.exec_transport,
                u.display_name AS client_display_name,
                u.email        AS client_email,
                u.phone_e164   AS client_phone
           FROM lite_bookings b
           LEFT JOIN public.users u ON u.id = b.client_id
          WHERE b.id = $1`,
        [mission.booking_id],
      ),
      this.db.qOne<{
        id: string; call_sign: string; make_model: string; plate: string;
        armored: boolean; armor_grade: string | null; capacity: number;
      }>(
        `SELECT v.id, v.call_sign, v.make_model, v.plate, v.armored, v.armor_grade, v.capacity
           FROM lite_bookings b
           JOIN vehicle_pool v ON v.id = b.vehicle_id
          WHERE b.id = $1`,
        [mission.booking_id],
      ),
      // Executive Protection — the hourly "all smooth" record (empty for non-executive).
      this.db.q<{hour_index: number; status: string; comment: string | null; created_at: Date}>(
        `SELECT hour_index, status, comment, created_at
           FROM mission_hourly_checkins WHERE mission_id = $1 ORDER BY hour_index`,
        [id],
      ),
    ]);
    return {mission, crew, waypoints, principals, sos, audit, booking, vehicle,
            hourly_checkins: hourlyCheckins};
  }

  // ─── Route alternatives (RE-ROUTE picker) ─────────────────────────

  /**
   * Returns up to 3 driving routes between the booking's pickup and
   * dropoff so ops can pick which road the crew should follow. The
   * currently-selected polyline (mission.route_polyline) is flagged so
   * the picker can highlight it.
   */
  async getRouteOptions(missionId: string, admin: AdminContext): Promise<{
    options: Array<{
      key: string;
      distance_m: number;
      duration_s: number;
      polyline: string | null;
      is_current: boolean;
    }>;
    pickup:  {lat: number; lng: number} | null;
    dropoff: {lat: number; lng: number} | null;
  }> {
    const mission = await this.db.qOne<MissionRow & {route_polyline: string | null}>(
      `SELECT * FROM missions WHERE id = $1`, [missionId],
    );
    if (!mission) throw new NotFoundException('Mission not found');
    // Audit AUTH-01 — region-scope this by-id read like the mutations do.
    await this.assertMissionRegion(admin, mission.booking_id);
    const booking = await this.db.qOne<{
      pickup_lat: string | null; pickup_lng: string | null;
      dropoff_lat: string | null; dropoff_lng: string | null;
    }>(
      `SELECT pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
         FROM lite_bookings WHERE id = $1`,
      [mission.booking_id],
    );
    if (!booking?.pickup_lat || !booking.pickup_lng || !booking.dropoff_lat || !booking.dropoff_lng) {
      throw new BadRequestException('Booking is missing pickup or dropoff coordinates');
    }
    const pickup  = {lat: Number(booking.pickup_lat),  lng: Number(booking.pickup_lng)};
    const dropoff = {lat: Number(booking.dropoff_lat), lng: Number(booking.dropoff_lng)};

    const raw = await this.mapbox.getRouteAlternatives(pickup, dropoff);
    const currentPoly = mission.route_polyline;
    return {
      pickup, dropoff,
      options: raw.map(r => ({
        ...r,
        is_current: r.polyline !== null && r.polyline === currentPoly,
      })),
    };
  }

  /**
   * Persist a chosen route — the CPO mobile app polls
   * `lite_bookings.route_polyline` and switches over within one cycle.
   */
  async selectRoute(
    missionId: string,
    args: {polyline: string; distance_m: number; duration_s: number},
    admin: AdminContext,
  ): Promise<void> {
    const mission = await this.requireMission(missionId);
    // Audit H3 — region isolation: re-routing changes where a live detail
    // is driven; a region-scoped admin must not redirect a mission outside
    // their region.
    await this.assertMissionRegion(admin, mission.booking_id);
    if (['COMPLETED', 'ABORTED'].includes(mission.status)) {
      throw new BadRequestException(`Cannot re-route a ${mission.status} mission`);
    }
    if (!args.polyline) throw new BadRequestException('polyline is required');

    await this.db.q(
      `UPDATE missions
          SET route_polyline   = $2,
              route_distance_m = $3,
              route_duration_s = $4
        WHERE id = $1`,
      [missionId, args.polyline, args.distance_m, args.duration_s],
    );
    await this.audit.recordAdmin(admin, 'mission.reroute', 'mission', missionId, {
      distance_m: args.distance_m, duration_s: args.duration_s,
    });
    await this.audit.emit({
      kind: 'mission.reroute', severity: 'info',
      actor: admin.call_sign, subject: mission.short_code,
      message: `Route updated by ${admin.call_sign} · ${(args.distance_m / 1000).toFixed(1)} km · ${Math.round(args.duration_s / 60)} min`,
    });
    await this.postToOpsRoom(mission, 'mission_live',
      `Route updated by ${admin.call_sign} · ${(args.distance_m / 1000).toFixed(1)} km`,
      'info', admin.call_sign);
  }

  // ─── Telemetry (agent posts from mobile) ──────────────────────────

  /**
   * @deprecated B-89 P3-D — unrouted since audit fix 1.3 removed
   * `POST /ops/missions/:id/telemetry`. The live path is
   * MissionLeadService.pushTelemetry, which also mirrors to the
   * client-facing stores (MG-01). Kept only for its spec coverage of the
   * shared UPDATE shape; do not re-route without crew-membership checks.
   */
  async updateTelemetry(
    missionId: string,
    fix: {lat: number; lng: number; heading_deg?: number; speed_kph?: number},
  ): Promise<void> {
    const row = await this.requireMission(missionId);
    if (['COMPLETED', 'ABORTED'].includes(row.status)) {
      throw new BadRequestException(`Mission is terminal (${row.status})`);
    }
    await this.db.q(
      `UPDATE missions
          SET current_lat = $2, current_lng = $3,
              heading_deg = COALESCE($4, heading_deg),
              speed_kph   = COALESCE($5, speed_kph)
        WHERE id = $1`,
      [missionId, fix.lat, fix.lng, fix.heading_deg ?? null, fix.speed_kph ?? null],
    );
    // Mirror into mission_telemetry_last (existing fallback table).
    await this.db.q(
      `INSERT INTO mission_telemetry_last (booking_id, lat, lng, heading_deg, speed_kph, source)
       VALUES ($1,$2,$3,$4,$5,'agent')
       ON CONFLICT (booking_id) DO UPDATE
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng,
             heading_deg = EXCLUDED.heading_deg, speed_kph = EXCLUDED.speed_kph,
             recorded_at = NOW()`,
      [row.booking_id, fix.lat, fix.lng, fix.heading_deg ?? null, fix.speed_kph ?? null],
    );
    // Audit fix 5.1 — push the fresh fix to mission:<id> subscribers.
    void this.events?.telemetryFix(missionId, {
      lat: fix.lat, lng: fix.lng,
      recordedAt: new Date().toISOString(),
    }, row.booking_id);
  }

  // ─── State transitions ────────────────────────────────────────────

  async pickup(missionId: string, actor: MissionActor = 'AGENT'): Promise<void> {
    const m = await this.requireMission(missionId);
    this.fsm.assert(m.status, 'PICKUP', actor);
    await this.setStatus(missionId, 'PICKUP');
    await this.audit.record({
      actor_role: actor, action: 'mission.pickup',
      subject_type: 'mission', subject_id: missionId,
    });
    await this.audit.emit({kind: 'mission.pickup', severity: 'ok', subject: m.short_code,
      message: `Principal onboard · ${m.short_code}`});
    await this.postToOpsRoom(m, 'mission_pickup',
      `Principal onboard · ${m.short_code}`, 'ok');
    // Audit fix 5.1 — broadcast to BOTH mission:<missionId> and
    // mission:<bookingId> rooms. Mobile holds bookingId from the
    // navigation route; ops console holds missionId — either side
    // can subscribe with whichever it has.
    void this.events?.statusChanged(missionId, 'PICKUP', m.booking_id);
  }

  async goLive(missionId: string, actor: MissionActor = 'AGENT'): Promise<void> {
    const m = await this.requireMission(missionId);
    this.fsm.assert(m.status, 'LIVE', actor);
    await this.setStatus(missionId, 'LIVE');
    await this.audit.record({
      actor_role: actor, action: 'mission.live',
      subject_type: 'mission', subject_id: missionId,
    });
    await this.postToOpsRoom(m, 'mission_live',
      `Mission LIVE · en route · ${m.short_code}`, 'info');
    void this.events?.statusChanged(missionId, 'LIVE', m.booking_id);
  }

  async complete(missionId: string, actor: MissionActor = 'AGENT'): Promise<void> {
    const m = await this.requireMission(missionId);
    this.fsm.assert(m.status, 'COMPLETED', actor);
    await this.db.q(
      `UPDATE missions SET status = 'COMPLETED', ended_at = NOW() WHERE id = $1`,
      [missionId],
    );
    await this.db.q(
      `UPDATE lite_bookings SET status = 'COMPLETED' WHERE id = $1`,
      [m.booking_id],
    );
    await this.audit.record({
      actor_role: actor, action: 'mission.complete',
      subject_type: 'mission', subject_id: missionId,
    });
    await this.audit.emit({kind: 'mission.complete', severity: 'ok', subject: m.short_code,
      message: `Mission ${m.short_code} completed`});
    await this.postToOpsRoom(m, 'mission_complete',
      `Mission ${m.short_code} completed · clean handoff`, 'ok');
    // B-207 — hard-delete the Ops Room on completion (founder: delete, not archive).
    if (m.comms_channel_id) {
      await this.systemMsg.deleteMissionRoom(m.comms_channel_id, 'mission_completed');
    }
    void this.events?.statusChanged(missionId, 'COMPLETED', m.booking_id);
    // LM-N4 — completion wake to the CLIENT (was Ops-Room-card only).
    try {
      const owner = await this.db.qOne<{client_id: string}>(
        `SELECT client_id FROM lite_bookings WHERE id = $1`, [m.booking_id],
      );
      if (owner) {
        void this.bookingPush?.bookingCompleted(owner.client_id, m.booking_id);
      }
    } catch { /* wake is best-effort */ }
  }

  /** Ops/Admin terminates an in-flight mission (e.g. after escalation). */
  async abort(
    missionId: string,
    admin: AdminContext,
    reason: string,
    notes?: string,
  ): Promise<void> {
    const m = await this.requireMission(missionId);
    // Audit H3 — region isolation: a region-scoped OPS/SUPERVISOR must not
    // abort a mission outside their region (abort cancels the booking and
    // now triggers a refund, so it's a money- and ops-affecting action).
    await this.assertMissionRegion(admin, m.booking_id);
    const actor: MissionActor = admin.role === 'OPS' ? 'OPS' : 'ADMIN';
    this.fsm.assert(m.status, 'ABORTED', actor);
    // Audit M1 — flip mission + booking atomically so a reader can't catch
    // the mission ABORTED while the booking still says CONFIRMED (or the
    // reverse if the second UPDATE fails). Capture the booking's client +
    // captured-payment flag in the same txn for the refund below.
    const bk = await this.db.withTransaction(async tx => {
      await tx.q(
        `UPDATE missions
            SET status = 'ABORTED', ended_at = NOW(),
                ended_by = $2, end_reason = $3
          WHERE id = $1`,
        [missionId, admin.user_id, reason],
      );
      // Stand the mission crew down — every sibling terminal path (client cancel,
      // arrival no-show, lead complete) does this; without it the partial unique
      // mission_crew_agent_active_uq keeps each CPO "busy" forever after an ops
      // abort and they can never be re-crewed.
      await tx.q(
        `UPDATE mission_crew SET status = 'off' WHERE mission_id = $1 AND status <> 'off'`,
        [missionId],
      );
      // Release the assigned CPOs + vehicle back to the pool. Without this
      // an aborted mission leaves its crew stuck at availability='on_mission'
      // forever, so the next dispatch that re-picks them fails with
      // `cpo_unavailable` (cpo_pool.id is the agent user_id; not 'on_mission'
      // guard avoids clobbering a row already re-claimed by another mission).
      await tx.q(
        `UPDATE cpo_pool SET availability = 'available'
          WHERE id IN (SELECT cpo_id FROM booking_cpo_assignments WHERE booking_id = $1)
            AND availability = 'on_mission'`,
        [m.booking_id],
      );
      await tx.q(`DELETE FROM booking_cpo_assignments WHERE booking_id = $1`, [m.booking_id]);
      // Vehicle is linked via lite_bookings.vehicle_id and keyed by `status`
      // (enum: available|on_mission|maintenance) — mirror vehicle-pool.release.
      await tx.q(
        `UPDATE vehicle_pool SET status = 'available'
          WHERE id = (SELECT vehicle_id FROM lite_bookings WHERE id = $1)
            AND status = 'on_mission'`,
        [m.booking_id],
      );
      const booking = await tx.qOne<{client_id: string; payment_captured: boolean; payer_user_id: string | null}>(
        `UPDATE lite_bookings SET status = 'CANCELLED'
          WHERE id = $1
        RETURNING client_id, payment_captured, payer_user_id`,
        [m.booking_id],
      );
      // Step 11 §39.3-4 — escrow refund/pro-rata matrix. An AUTO-dispatch booking
      // carries an escrow hold; reverse it ATOMICALLY with the abort (matching the
      // crew-SLA no-show precedent) instead of the legacy total_eur refund:
      //   • pre-LIVE (live_at IS NULL, principal never onboard) → FULL refund.
      //   • mid-LIVE → PARTIAL pro-rata against minutes actually on task: provider keeps
      //     the worked share (− platform fee), client refunded the unworked remainder.
      // CRITICAL (race): detect a hold in ANY state, not just HELD. If a lead Finish has
      // already flipped HELD→PENDING_RELEASE (or the hold otherwise left HELD), the booking
      // is STILL an auto booking — falling through to the legacy refundForBooking below
      // would double-refund the client while the sweep later pays the agency. So set
      // escrowHandled=true whenever a hold exists; only actively reverse a still-HELD hold
      // (a PENDING_RELEASE/terminal hold is governed by the escrow lifecycle, not abort).
      const hold = await tx.qOne<{status: string; gross_credits: number; duration_hours: number; worked_minutes: string | null}>(
        // LM-B1: bind the join to THIS mission — the booking can carry ABORTED
        // history rows from prior re-dispatch rounds, and worked_minutes must be
        // computed from the mission actually being aborted.
        `SELECT eh.status, eh.gross_credits, b.duration_hours,
                CASE WHEN m.live_at IS NULL THEN NULL
                     ELSE EXTRACT(EPOCH FROM (NOW() - m.live_at)) / 60 END AS worked_minutes
           FROM escrow_holds eh
           JOIN lite_bookings b ON b.id = eh.booking_id
           JOIN missions m ON m.id = $2
          WHERE eh.booking_id = $1`,
        [m.booking_id, missionId],
      );
      const escrowHandled = !!hold;
      let refundedCredits = 0;
      // LM-B6 — abort AFTER the lead already hit Finish (hold PENDING_RELEASE): the
      // release sweep would later pay the agency IN FULL for a mission an admin just
      // aborted. Freeze it to DISPUTED (+ an open dispute row for the ops queue) so a
      // human decides the split via the existing dispute-resolve flow instead.
      if (hold && hold.status === 'PENDING_RELEASE') {
        const frozen = await tx.q(
          `UPDATE escrow_holds SET status = 'DISPUTED'
            WHERE booking_id = $1 AND status = 'PENDING_RELEASE' RETURNING id`,
          [m.booking_id],
        );
        if (frozen.length > 0) {
          try {
            await tx.q(
              `INSERT INTO booking_disputes (booking_id, raised_by, category, reason, status)
               VALUES ($1, $2, 'admin_abort', $3, 'open')`,
              [m.booking_id, admin.user_id, `Mission ${m.short_code} aborted post-finish: ${reason}`],
            );
          } catch (e) {
            // booking_disputes_one_open — a live dispute already covers it.
            if (!/duplicate key|unique/i.test((e as Error).message)) throw e;
          }
        }
      }
      if (hold && hold.status === 'HELD') {
        if (hold.worked_minutes === null) {
          const r = await this.wallet.refundEscrowHold(tx, m.booking_id, `Refund · mission ${m.short_code} aborted (pre-live)`);
          refundedCredits = r.credits;
        } else {
          const worked = Math.max(0, Number(hold.worked_minutes));
          const contracted = Math.max(1, (hold.duration_hours ?? 1) * 60);
          const frac = Math.min(1, worked / contracted);
          const grossWorked = Math.min(hold.gross_credits, Math.round(hold.gross_credits * frac));
          const feePct = this.config.get<number>('dispatch.platformFeePct') ?? 0;
          const fee = Math.min(grossWorked, Math.max(0, Math.round((grossWorked * feePct) / 100)));
          const r = await this.wallet.settleEscrowSplit(tx, m.booking_id, {
            toProvider: grossWorked - fee,
            toClient: hold.gross_credits - grossWorked,
            basis: 'pro_rata',
            fromStatuses: ['HELD'],
            finalStatus: 'PARTIAL',
            reason: `Abort pro-rata · mission ${m.short_code}`,
          });
          refundedCredits = r.toClient;
        }
      }
      return {
        client_id: booking?.client_id ?? null,
        // B-374 — the legacy refund must credit the wallet that PAID (family
        // holder on a member booking); summing debits on the member's wallet
        // finds nothing and silently refunds nobody.
        payer_id: booking?.payer_user_id ?? booking?.client_id ?? null,
        payment_captured: booking?.payment_captured ?? false,
        escrowHandled,
        refundedCredits,
      };
    });
    // Audit C2 — legacy total_eur refund for a non-escrow (admin-flow) booking. Same
    // idempotent path as the client-cancel refund, so a client cancel that raced this
    // abort can't double-refund. Skipped for auto bookings (handled in-txn above).
    let legacyRefund = 0;
    if (!bk.escrowHandled && bk.payment_captured && bk.payer_id) {
      try {
        const r = await this.wallet.refundForBooking(
          bk.payer_id, m.booking_id, `Refund · mission ${m.short_code} aborted`,
        );
        legacyRefund = r.credits;
      } catch (e) {
        this.log.error(`refund failed on abort for booking ${m.booking_id}: ${(e as Error).message}`);
      }
    }
    // LM-N4 — the client didn't initiate this abort; never move their money silently.
    const totalRefund = (bk.refundedCredits ?? 0) + legacyRefund;
    if (bk.client_id && totalRefund > 0) {
      void this.bookingPush?.refundIssued(bk.client_id, m.booking_id, totalRefund);
    }
    await this.audit.recordAdmin(admin, 'mission.abort', 'mission', missionId, {reason, notes});
    await this.audit.emit({
      kind: 'mission.abort', severity: 'err', actor: admin.call_sign, subject: m.short_code,
      message: `Mission ${m.short_code} aborted by ${admin.call_sign} · ${reason}`,
    });
    await this.postToOpsRoom(m, 'mission_abort',
      `Mission aborted by ${admin.call_sign} · ${reason}`, 'err', admin.call_sign);
    void this.events?.statusChanged(missionId, 'ABORTED', m.booking_id);
    // Wake every crew member's phone so an agent en route doesn't show
    // up at the pickup unaware the mission was killed. The mobile
    // LiveTracker also now navigates away on ABORTED status, but the
    // poll-only path requires the screen to be mounted to fire.
    try {
      const crew = await this.db.q<{agent_id: string}>(
        `SELECT agent_id FROM mission_crew WHERE mission_id = $1`, [missionId],
      );
      for (const c of crew) {
        void this.bookingPush?.missionAborted(c.agent_id, missionId, m.booking_id);
      }
    } catch (e) { /* never fail the abort on a push hiccup */ void e; }
    // B-207 — hard-delete the Ops Room on abort too (founder: delete, not archive).
    if (m.comms_channel_id) {
      await this.systemMsg.deleteMissionRoom(m.comms_channel_id, `mission_aborted:${reason}`);
    }
  }

  // ─── SOS ──────────────────────────────────────────────────────────

  /** Agent triggers SOS from mobile. */
  async triggerSos(
    missionId: string,
    args: {agent_id?: string; agent_call_sign?: string; reason: string; lat?: number; lng?: number},
  ): Promise<SosRow> {
    const m = await this.requireMission(missionId);
    if (['COMPLETED', 'ABORTED'].includes(m.status)) {
      throw new BadRequestException(`Cannot raise SOS on ${m.status} mission`);
    }
    // Mission transitions to SOS if not already.
    if (m.status !== 'SOS') {
      this.fsm.assert(m.status, 'SOS', 'AGENT');
      await this.setStatus(missionId, 'SOS');
    }
    const sos = await this.db.qOne<SosRow>(
      `INSERT INTO sos_events
         (mission_id, agent_id, agent_call_sign, reason, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [missionId, args.agent_id ?? null, args.agent_call_sign ?? null,
       args.reason, args.lat ?? null, args.lng ?? null],
    );
    if (!sos) throw new BadRequestException('Failed to record SOS');
    await this.audit.record({
      actor_id: args.agent_id, actor_call: args.agent_call_sign,
      actor_role: 'AGENT', action: 'sos.trigger',
      subject_type: 'sos', subject_id: sos.id,
      metadata: {mission_id: missionId, reason: args.reason},
    });
    await this.audit.emit({
      kind: 'sos', severity: 'err',
      actor: args.agent_call_sign ?? 'CPO',
      subject: m.short_code,
      message: `SOS · ${args.agent_call_sign ?? 'CPO'} triggered emergency on mission ${m.short_code} · ${args.reason}`,
    });
    await this.postToOpsRoom(m, 'mission_sos',
      `⚠ SOS · ${args.agent_call_sign ?? 'CPO'} · ${args.reason}`,
      'err', args.agent_call_sign);
    return sos;
  }

  /** Ops acknowledges the SOS alert (red badge stops pulsing). */
  async ackSos(sosId: string, admin: AdminContext, notes?: string): Promise<void> {
    const sos = await this.db.qOne<SosRow>(`SELECT * FROM sos_events WHERE id = $1`, [sosId]);
    if (!sos) throw new NotFoundException('SOS event not found');
    await this.assertSosRegion(admin, sos.mission_id); // AUTHZ-2
    if (sos.acknowledged_at) return;
    await this.db.q(
      `UPDATE sos_events
          SET acknowledged_at = NOW(), acknowledged_by = $2
        WHERE id = $1`,
      [sosId, admin.user_id],
    );
    await this.audit.recordAdmin(admin, 'sos.ack', 'sos', sosId, {notes});
    const m = await this.db.qOne<MissionRow>(`SELECT * FROM missions WHERE id = $1`, [sos.mission_id]);
    if (m) {
      await this.postToOpsRoom(m, 'mission_sos_ack',
        `SOS acknowledged by ${admin.call_sign}`, 'warn', admin.call_sign);
      // Audit fix 5.1 — surface "ops just acked your SOS" to the mission
      // subscribers (mobile dashboard polling) without waiting for the
      // next 3s tick. The Dashboard already has its own /sos/:id/status
      // poll for the panic UI; this is the mission-channel mirror.
      void this.events?.broadcastBoth(m.id, m.booking_id, 'mission.status', {sosAcked: true, ackedBy: admin.call_sign});
    }
  }

  /** Escalate to external authority (police / embassy / family). */
  async escalateSos(
    sosId: string, admin: AdminContext, to: string, notes?: string,
  ): Promise<void> {
    // AUTHZ-2 — load the SOS first (this was a blind UPDATE with no existence check)
    // so we can region-scope it; a foreign-region OPS/SUPERVISOR is refused.
    const sos = await this.db.qOne<SosRow>(`SELECT * FROM sos_events WHERE id = $1`, [sosId]);
    if (!sos) throw new NotFoundException('SOS event not found');
    await this.assertSosRegion(admin, sos.mission_id);
    await this.db.q(
      `UPDATE sos_events
          SET escalated_at = NOW(), escalated_to = $2
        WHERE id = $1`,
      [sosId, to],
    );
    await this.audit.recordAdmin(admin, 'sos.escalate', 'sos', sosId, {escalated_to: to, notes});
  }

  /** Resolve SOS — optionally returning mission to LIVE if it's a false alarm. */
  async resolveSos(
    sosId: string, admin: AdminContext, resolution: string, returnToLive = true,
  ): Promise<void> {
    const sos = await this.db.qOne<SosRow>(`SELECT * FROM sos_events WHERE id = $1`, [sosId]);
    if (!sos) throw new NotFoundException('SOS event not found');
    await this.assertSosRegion(admin, sos.mission_id); // AUTHZ-2
    await this.db.q(
      `UPDATE sos_events SET resolved_at = NOW(), resolution = $2 WHERE id = $1`,
      [sosId, resolution],
    );
    if (returnToLive) {
      const m = await this.requireMission(sos.mission_id);
      if (m.status === 'SOS') {
        const actor: MissionActor = admin.role === 'OPS' ? 'OPS' : 'ADMIN';
        this.fsm.assert('SOS', 'LIVE', actor);
        // FSM-4 — status-guarded so a concurrent lead Finish (SOS->COMPLETED)
        // between the read above and this write can't be resurrected to LIVE (the
        // trigger would reject COMPLETED->LIVE with a 500). live_at is anchored
        // exactly as setStatus('LIVE') does.
        await this.db.q(
          `UPDATE missions SET status = 'LIVE', live_at = COALESCE(live_at, NOW())
            WHERE id = $1 AND status = 'SOS'`,
          [sos.mission_id],
        );
      }
    }
    await this.audit.recordAdmin(admin, 'sos.resolve', 'sos', sosId, {resolution, return_to_live: returnToLive});
    const m2 = await this.db.qOne<MissionRow>(`SELECT * FROM missions WHERE id = $1`, [sos.mission_id]);
    if (m2) {
      await this.postToOpsRoom(m2, 'mission_sos_resolved',
        `SOS resolved by ${admin.call_sign} · ${resolution}`, 'ok', admin.call_sign);
    }
  }

  // ─── Waypoints ────────────────────────────────────────────────────

  async advanceWaypoint(missionId: string, seq: number, state: 'current' | 'done'): Promise<void> {
    await this.requireMission(missionId);
    await this.db.q(
      `UPDATE mission_waypoints
          SET state = $3,
              settled_at = CASE WHEN $3 = 'done' THEN NOW() ELSE settled_at END
        WHERE mission_id = $1 AND seq = $2`,
      [missionId, seq, state],
    );
  }

  /** Public alias for callers that only need the bare row (e.g. ops
   *  controller resolving comms_channel_id for free-form messaging). */
  getMissionRow(id: string): Promise<MissionRow> {
    return this.requireMission(id);
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async requireMission(id: string): Promise<MissionRow> {
    const row = await this.db.qOne<MissionRow>(`SELECT * FROM missions WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('Mission not found');
    return row;
  }

  /**
   * Audit H3 — assert the admin is allowed to act on the mission's region.
   * The region lives on the parent booking (missions have no region column),
   * so we resolve it via booking_id. A global ADMIN bypasses (see
   * `assertRegionScope`); a region-scoped OPS/SUPERVISOR is confined to
   * their own region. Missing booking → fail closed.
   */
  private async assertMissionRegion(admin: AdminContext, bookingId: string): Promise<void> {
    const b = await this.db.qOne<{region_code: string}>(
      `SELECT region_code FROM lite_bookings WHERE id = $1`, [bookingId],
    );
    if (!b) throw new NotFoundException('Booking not found for mission');
    assertRegionScope(admin, b.region_code);
  }

  /**
   * AUTHZ-2 — region-scope an SOS action via its mission's booking. A bare client
   * panic (mission_id null) has no region context, so it is left to any ops — a
   * safety alert must never be swallowed by a scope mismatch. A global ADMIN
   * bypasses; a region-scoped OPS/SUPERVISOR is confined to their own region.
   */
  private async assertSosRegion(admin: AdminContext, missionId: string | null): Promise<void> {
    if (!missionId) return;
    const r = await this.db.qOne<{region_code: string}>(
      `SELECT b.region_code FROM missions m JOIN lite_bookings b ON b.id = m.booking_id WHERE m.id = $1`,
      [missionId],
    );
    if (r) assertRegionScope(admin, r.region_code);
  }

  private setStatus(id: string, status: MissionStatus) {
    // Entering LIVE must anchor the clock exactly once: an SOS raised during
    // PICKUP and resolved with return-to-LIVE otherwise lands on LIVE with a
    // NULL live_at — which silently kills the Executive Protection hourly check-in
    // system for the whole block (every confirm 400s `mission_not_live`).
    if (status === 'LIVE') {
      return this.db.q(
        `UPDATE missions SET status = $2, live_at = COALESCE(live_at, NOW()) WHERE id = $1`,
        [id, status],
      );
    }
    return this.db.q(`UPDATE missions SET status = $2 WHERE id = $1`, [id, status]);
  }
}
