import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {bearingDeg, haversineMeters} from '../ops/mapbox-directions.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {TelemetryService} from '../telemetry/telemetry.service';
import {MissionStateMachine} from '../ops/mission-state-machine.service';

// FSM defense-in-depth — the conditional UPDATEs below already pin a legal
// from-state in their WHERE; asserting here makes the FSM the single source of
// truth. These flips are AGENT-attributed (both are gated by requireLead), so
// the actor is AGENT, matching AgentService.flipMissionStatus.
const missionFsm = new MissionStateMachine();

/**
 * CPO-Lead waypoint marking + GPS telemetry.
 *
 * Manual waypoints (DISPATCH, RECON, PICKUP, DROPOFF) are stamped by the
 * mission lead from their phone. EN_ROUTE auto-fires immediately after
 * PICKUP. CHKPT 01 / CHKPT 02 auto-fire when the lead's GPS distance to
 * the dropoff drops below 50% / 20% of the precomputed route distance.
 *
 * Telemetry is appended to mission_telemetry on every push so we get a
 * trail; missions.current_lat/lng/heading_deg/speed_kph mirrors the
 * latest sample for cheap reads on the live ops map.
 */

/**
 * Grace window before telemetry is allowed to take a PICKUP mission LIVE on its
 * own. The lead's "Client Picked Up" confirmation is the real transition; this
 * only rescues a mission whose lead never tapped, which would otherwise be
 * unfinishable (Finish requires LIVE/SOS) and would never settle escrow.
 * Long enough that it never fires during a normal pickup.
 */
const TELEMETRY_GO_LIVE_FALLBACK_MIN = 15;

@Injectable()
export class MissionLeadService {
  private readonly log = new Logger(MissionLeadService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly events: MissionEventsService,
    private readonly telemetry: TelemetryService,
  ) {}

  // Tag → seq, must match the waypoints seeded at dispatch.
  private readonly TAG_TO_SEQ: Record<string, number> = {
    DISPATCH: 1, RECON: 2, PICKUP: 3, 'CHKPT 01': 4,
    'EN ROUTE': 5, 'CHKPT 02': 6, DROPOFF: 7,
  };
  private readonly LEAD_MARKABLE = new Set(['DISPATCH', 'RECON', 'PICKUP', 'DROPOFF']);

  private async requireLead(userId: string, missionId: string): Promise<{is_lead: boolean}> {
    const row = await this.db.qOne<{is_lead: boolean}>(
      `SELECT is_lead FROM mission_crew WHERE mission_id = $1 AND agent_id = $2`,
      [missionId, userId],
    );
    if (!row) throw new ForbiddenException('not_assigned_to_mission');
    if (!row.is_lead) throw new ForbiddenException('only_lead_can_mark');
    return row;
  }

  /** Mark a manual waypoint (DISPATCH / RECON / PICKUP / DROPOFF). */
  async markWaypoint(
    userId: string, missionId: string, tag: string,
  ): Promise<{ok: true; tag: string; seq: number; settled_at: string; auto_marks: string[]}> {
    if (!this.LEAD_MARKABLE.has(tag)) {
      throw new BadRequestException('not_a_lead_markable_waypoint');
    }
    await this.requireLead(userId, missionId);

    const seq = this.TAG_TO_SEQ[tag];
    const updated = await this.db.qOne<{settled_at: Date}>(
      `UPDATE mission_waypoints
          SET state = 'done',
              settled_at = COALESCE(settled_at, NOW()),
              marked_by = $3,
              marked_via = 'lead'
        WHERE mission_id = $1 AND seq = $2
        RETURNING settled_at`,
      [missionId, seq, userId],
    );
    if (!updated) throw new NotFoundException('waypoint_not_found');

    // EN_ROUTE auto-fires immediately after PICKUP.
    const autoMarks: string[] = [];
    if (tag === 'PICKUP') {
      const enRoute = await this.db.qOne<{settled_at: Date}>(
        `UPDATE mission_waypoints
            SET state = 'done',
                settled_at = COALESCE(settled_at, NOW()),
                marked_via = 'auto_pickup'
          WHERE mission_id = $1 AND seq = 5 AND state <> 'done'
          RETURNING settled_at`,
        [missionId],
      );
      if (enRoute) autoMarks.push('EN ROUTE');

      // Flip mission status DISPATCHED → PICKUP so the ops live feed +
      // mobile UIs reading missions.status reflect the on-ground state.
      // FSM allows DISPATCHED → PICKUP by AGENT
      // (mission-state-machine.service.ts). Conditional UPDATE so we
      // don't downgrade a mission that's already further along (LIVE,
      // SOS, COMPLETED, ABORTED).
      // LM-B3 — stamp pickup_at exactly like AgentService.flipMissionStatus does:
      // the proof-of-completion gate hard-requires it, and this path previously
      // left it NULL, flagging every waypoint-driven mission `no_progression` →
      // review_required → the escrow release sweep skipped it forever.
      missionFsm.assert('DISPATCHED', 'PICKUP', 'AGENT');
      const flipped = await this.db.qOne<{id: string; booking_id: string}>(
        `UPDATE missions SET status = 'PICKUP', updated_at = NOW(),
                pickup_at = COALESCE(pickup_at, NOW())
          WHERE id = $1 AND status = 'DISPATCHED'
        RETURNING id, booking_id`,
        [missionId],
      );
      // CLIENT-TRACKING (#13) — emit a realtime status frame ONLY on a real
      // transition (RETURNING-gated) so the client + agency see DISPATCHED→PICKUP
      // instantly instead of on the next 5s REST poll.
      if (flipped) { void this.events.statusChanged(missionId, 'PICKUP', flipped.booking_id); }
    }
    // DROPOFF stays NON-status-flipping by design — see the long
    // explanation below. Only ops's `completeBooking` closes a mission.

    // DROPOFF only marks the waypoint done — the mission STAYS in its
    // current operational status (LIVE/PICKUP/DISPATCHED) until ops runs
    // `completeBooking`. Earlier we auto-flipped `missions.status` to
    // 'COMPLETED' here, but that produced a half-closed state: the
    // mission row read COMPLETED while the booking was still LIVE, which
    // (a) made the live page show a stale COMPLETED badge before ops
    // had paid out, (b) left the agent's `conversation_members` row
    // intact (per-side group dissolution lives in completeBooking), so
    // the mission group stuck around on the agent's chat list forever,
    // and (c) put the mission in the Completed tab on /live before
    // payouts had cleared. Bottom line: only ops's explicit
    // END MISSION → PAYOUT closes a mission. Auto-fire here was a bug.

    await this.recordAudit(missionId, userId, `waypoint.${tag.toLowerCase().replace(' ', '_')}`, {seq});
    return {
      ok: true,
      tag,
      seq,
      settled_at: updated.settled_at.toISOString(),
      auto_marks: autoMarks,
    };
  }

  /**
   * Push a GPS sample. Updates missions.current_* + appends telemetry +
   * auto-fires CHKPT 01 / CHKPT 02 when distance to dropoff crosses
   * 50% / 20% of the route total.
   */
  async pushTelemetry(
    userId: string,
    missionId: string,
    sample: {
      lat: number; lng: number;
      heading_deg?: number; speed_kph?: number;
      accuracy_m?: number; battery_pct?: number;
    },
  ): Promise<{ok: true; auto_marks: string[]; distance_to_dropoff_m: number | null; progress_pct: number | null}> {
    await this.requireLead(userId, missionId);
    if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lng)) {
      throw new BadRequestException('invalid_coords');
    }

    const route = await this.db.qOne<{
      route_distance_m: number | null;
      route_duration_s: number | null;
      booking_id: string | null;
      prev_lat: number | null;
      prev_lng: number | null;
      booking_dropoff_lat: string | null;
      booking_dropoff_lng: string | null;
    }>(
      `SELECT m.route_distance_m, m.route_duration_s, m.booking_id,
              m.current_lat AS prev_lat, m.current_lng AS prev_lng,
              b.dropoff_lat AS booking_dropoff_lat,
              b.dropoff_lng AS booking_dropoff_lng
         FROM missions m
         JOIN lite_bookings b ON b.id = m.booking_id
        WHERE m.id = $1`,
      [missionId],
    );
    if (!route) throw new NotFoundException('mission_not_found');

    // MG-02 — devices frequently report NO GPS course (stationary, some
    // emulators/OEMs), so the heading cone stayed frozen. Derive the
    // bearing from the previous → current fix whenever the device value
    // is absent and the vehicle actually moved (≥8 m — below that the
    // bearing of GPS jitter is noise).
    let effectiveHeading: number | null = sample.heading_deg ?? null;
    if (effectiveHeading == null
        && route.prev_lat != null && route.prev_lng != null) {
      const prev = {lat: Number(route.prev_lat), lng: Number(route.prev_lng)};
      if (haversineMeters(prev.lat, prev.lng, sample.lat, sample.lng) >= 8) {
        effectiveHeading = Math.round(bearingDeg(prev, {lat: sample.lat, lng: sample.lng}));
      }
    }

    let distToDropoff: number | null = null;
    let progressPct:   number | null = null;
    if (route.booking_dropoff_lat && route.booking_dropoff_lng) {
      distToDropoff = Math.round(haversineMeters(
        sample.lat, sample.lng,
        Number(route.booking_dropoff_lat), Number(route.booking_dropoff_lng),
      ));
      if (route.route_distance_m && route.route_distance_m > 0) {
        progressPct = Math.max(0, Math.min(100,
          Math.round(100 * (1 - distToDropoff / route.route_distance_m)),
        ));
      }
    }

    await this.db.q(
      `INSERT INTO mission_telemetry
         (mission_id, agent_id, lat, lng, heading_deg, speed_kph, accuracy_m, distance_to_dropoff_m, battery_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [missionId, userId, sample.lat, sample.lng,
       effectiveHeading, sample.speed_kph ?? null,
       sample.accuracy_m ?? null, distToDropoff, sample.battery_pct ?? null],
    );

    await this.db.q(
      `UPDATE missions
          SET current_lat = $2, current_lng = $3,
              heading_deg = COALESCE($4, heading_deg),
              speed_kph   = COALESCE($5, speed_kph),
              updated_at  = NOW()
        WHERE id = $1`,
      [missionId, sample.lat, sample.lng,
       effectiveHeading, sample.speed_kph ?? null],
    );

    // B-89 MG-01 — mirror the fix to the CLIENT-facing stores + realtime.
    // The principal's LiveTracking screen reads `/telemetry/:bookingId/latest`
    // (Redis stream + mission_telemetry_last) and the `mission.telemetry` WS
    // frame; before this mirror those had NO living writer (the ops push
    // endpoint was removed by audit 1.3 and telemetryApi.ping was never
    // called), so the client watched a SIMULATED dot for the whole mission.
    // Best-effort: a mirror failure must never fail the CPO's push — the
    // ops-facing write above already succeeded.
    if (route.booking_id) {
      const recordedAt = new Date().toISOString();
      const etaMinutes = (distToDropoff != null
          && route.route_distance_m && route.route_distance_m > 0
          && route.route_duration_s && route.route_duration_s > 0)
        ? Math.max(1, Math.round((route.route_duration_s * (distToDropoff / route.route_distance_m)) / 60))
        : undefined;
      try {
        await this.telemetry.ping(route.booking_id, {
          lat: sample.lat,
          lng: sample.lng,
          heading_deg: effectiveHeading ?? undefined,
          speed_kph:   sample.speed_kph,
          eta_minutes: etaMinutes,
          source: 'agent',
          recorded_at: recordedAt,
        });
      } catch (e) {
        this.log.warn(`client telemetry mirror failed for ${missionId}: ${(e as Error).message}`);
      }
      void this.events.telemetryFix(missionId, {
        lat: sample.lat,
        lng: sample.lng,
        recordedAt,
        heading_deg: effectiveHeading ?? undefined,
        speed_kph:   sample.speed_kph,
        accuracy_m:  sample.accuracy_m,
        eta_minutes: etaMinutes,
      }, route.booking_id);
    }

    // Flip PICKUP → LIVE on the first real telemetry push so the ops
    // live feed reflects "moving" instead of staying on PICKUP forever.
    // FSM allows PICKUP → LIVE by AGENT
    // (mission-state-machine.service.ts). Conditional UPDATE leaves
    // higher states (SOS, COMPLETED, ABORTED) alone.
    // LM-B3 — stamp live_at (proof-gate requirement, see markWaypoint) AND advance
    // the booking CONFIRMED→LIVE exactly like AgentService.flipMissionStatus does on
    // the button path: without it the booking stayed CONFIRMED while the mission ran
    // LIVE (the drift observed on staging), the client's live view never activated,
    // and Finish's LIVE-guarded flip was unreachable.
    // CLIENT-PICKED-UP (founder deck, Aug 2026) — this used to flip PICKUP→LIVE on
    // the FIRST telemetry push, i.e. within seconds of arriving at the pickup point.
    // That made a deliberate "Client Picked Up" checkpoint impossible: the mission
    // announced itself as protection-active before anyone was in the vehicle, and
    // live_at — which drives the proof gate, the pre-LIVE full-refund boundary and
    // the executive check-in schedule — recorded "a GPS ping arrived", not "the
    // principal is aboard".
    //
    // The lead's confirmation is now the real transition (AgentService.flipMissionStatus).
    // This path survives only as an anti-strand FALLBACK: without it, a lead who never
    // taps leaves the mission in PICKUP forever, Finish (LIVE/SOS only) is unreachable,
    // and escrow never settles. It therefore waits out a grace window and is audited
    // under its own reason so a fallback go-live is never mistaken for a real one.
    missionFsm.assert('PICKUP', 'LIVE', 'AGENT');
    const wentLive = await this.db.qOne<{id: string; booking_id: string}>(
      `UPDATE missions SET status = 'LIVE', updated_at = NOW(),
              live_at = COALESCE(live_at, NOW())
        WHERE id = $1 AND status = 'PICKUP'
          AND pickup_at IS NOT NULL
          AND pickup_at < NOW() - ($2 || ' minutes')::interval
      RETURNING id, booking_id`,
      [missionId, String(TELEMETRY_GO_LIVE_FALLBACK_MIN)],
    );
    // CLIENT-TRACKING (#13) — emit LIVE realtime ONLY on the actual PICKUP→LIVE
    // transition (not on every telemetry push) so the client view goes live instantly.
    if (wentLive) {
      if (wentLive.booking_id) {
        const flipped = await this.db.q(
          `UPDATE lite_bookings SET status = 'LIVE' WHERE id = $1 AND status = 'CONFIRMED' RETURNING id`,
          [wentLive.booking_id],
        );
        if (flipped.length > 0) {
          await this.db.q(
            `INSERT INTO lite_booking_audit (booking_id, from_status, to_status, actor_id, actor_role, metadata)
             VALUES ($1, 'CONFIRMED', 'LIVE', $2, 'CPO', $3::jsonb)`,
            [wentLive.booking_id, userId, JSON.stringify({
              reason: 'telemetry_go_live_fallback',
              mission_id: missionId,
              fallback_after_min: TELEMETRY_GO_LIVE_FALLBACK_MIN,
            })],
          ).catch(() => undefined);
        }
      }
      void this.events.statusChanged(missionId, 'LIVE', wentLive.booking_id);
    }

    // Auto-fire checkpoint waypoints based on progress.
    const autoMarks: string[] = [];
    if (progressPct != null) {
      if (progressPct >= 50) {
        const r = await this.db.qOne<{seq: number}>(
          `UPDATE mission_waypoints
              SET state = 'done',
                  settled_at = COALESCE(settled_at, NOW()),
                  marked_via = 'auto_distance'
            WHERE mission_id = $1 AND seq = 4 AND state <> 'done'
            RETURNING seq`,
          [missionId],
        );
        if (r) autoMarks.push('CHKPT 01');
      }
      if (progressPct >= 80) {
        const r = await this.db.qOne<{seq: number}>(
          `UPDATE mission_waypoints
              SET state = 'done',
                  settled_at = COALESCE(settled_at, NOW()),
                  marked_via = 'auto_distance'
            WHERE mission_id = $1 AND seq = 6 AND state <> 'done'
            RETURNING seq`,
          [missionId],
        );
        if (r) autoMarks.push('CHKPT 02');
      }
    }

    return {ok: true, auto_marks: autoMarks, distance_to_dropoff_m: distToDropoff, progress_pct: progressPct};
  }

  private async recordAudit(missionId: string, userId: string, action: string, metadata: Record<string, unknown>) {
    try {
      await this.db.q(
        `INSERT INTO ops_audit (actor_role, actor_id, action, subject_type, subject_id, metadata)
         VALUES ('AGENT', $1, $2, 'mission', $3, $4::jsonb)`,
        [userId, action, missionId, JSON.stringify(metadata)],
      );
    } catch (e) {
      this.log.warn(`Audit insert failed: ${(e as Error).message}`);
    }
  }
}
