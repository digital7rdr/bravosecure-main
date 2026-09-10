import {Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {AuditService} from '../kafka/audit.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {MissionStateMachine, type MissionStatus} from '../ops/mission-state-machine.service';

// FSM-1 — pure, stateless mission FSM consulted by the client-panic writer.
const missionFsm = new MissionStateMachine();

export interface SosStatusDto {
  id:                string;
  status:            string;
  triggered_at:      string;
  acknowledged_at:   string | null;
  acknowledged_by:   string | null;
  escalated_at:      string | null;
  resolved_at:       string | null;
}

/**
 * Audit fix 0.7 — client-side SOS triggered from the Lite dashboard.
 *
 * The original flow was UI-only: tapping the button transitioned the
 * local state to "activated" and never reached the server. This service
 * persists the alert into `sos_events`, fans an event into ops audit so
 * the live activity feed lights up, and emits a Kafka event for the
 * dispatch / pager surfaces.
 *
 * NOT booking-scoped — a panic press from anywhere in the app should
 * be recorded even if the user has no active booking. `bookingId` is
 * optional; the row carries `user_id + status='active'` and ops sees
 * it in the unacknowledged feed.
 */
@Injectable()
export class SosService {
  private readonly log = new Logger(SosService.name);

  constructor(
    private readonly db:        DatabaseService,
    private readonly redis:     RedisService,
    private readonly audit:     AuditService,
    private readonly opsAudit:  OpsAuditService,
    private readonly push:      BookingPushBridge,
    private readonly events:    MissionEventsService,
  ) {}

  async raise(
    userId: string,
    args: {bookingId?: string; lat?: number; lng?: number; reason?: string; payload?: Record<string, unknown>},
  ): Promise<{id: string; triggered_at: string}> {
    const reason  = (args.reason ?? 'panic_button').slice(0, 64);
    const payload = JSON.stringify({
      ...(args.payload ?? {}),
      source:    'lite_dashboard',
      reason,
    });

    // Optional point geometry — only set when the client supplied a fix.
    // The EWKT string carries `lat`/`lng` as literals (PostGIS does not
    // accept bound parameters inside an EWKT body), so we re-validate
    // the numbers at the service boundary as a defense in depth on top
    // of the DTO's @IsLatitude/@IsLongitude. `Number.isFinite` rejects
    // Infinity/NaN; the range bounds match PostGIS's SRID=4326 domain.
    // The whole EWKT string is then passed as the bound parameter $3
    // to ST_GeogFromText, so even if a future regression makes one of
    // these checks fall over, the value still never reaches the SQL
    // text as code.
    const isFiniteLat = typeof args.lat === 'number' && Number.isFinite(args.lat) && args.lat >= -90  && args.lat <= 90;
    const isFiniteLng = typeof args.lng === 'number' && Number.isFinite(args.lng) && args.lng >= -180 && args.lng <= 180;
    const point = (isFiniteLat && isFiniteLng)
      ? `SRID=4326;POINT(${Number(args.lng)} ${Number(args.lat)})`
      : null;

    // §7 — link an ACTIVE protection session: stamp its id on the SOS row and,
    // when the caller sent no fix, snapshot the session's last known location so
    // ops/CPO see WHERE the panic happened. Coordinates are never logged.
    const psession = await this.db.qOne<{id: string; cpo_user_id: string}>(
      `SELECT id, cpo_user_id FROM public.protection_sessions
        WHERE customer_id = $1 AND status IN ('REQUESTED','ACTIVE','ENDING')
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    let effLat = isFiniteLat ? args.lat! : null;
    let effLng = isFiniteLng ? args.lng! : null;
    let effPoint = point;
    if (psession && (effLat === null || effLng === null)) {
      const last = await this.db.qOne<{lat: number; lng: number}>(
        `SELECT lat, lng FROM public.protection_session_locations
          WHERE session_id = $1 ORDER BY received_at DESC LIMIT 1`,
        [psession.id],
      );
      if (last && Number.isFinite(Number(last.lat)) && Number.isFinite(Number(last.lng))) {
        effLat = Number(last.lat);
        effLng = Number(last.lng);
        effPoint = `SRID=4326;POINT(${effLng} ${effLat})`;
      }
    }

    // Issue 44 — a client SOS used to write a sos_events row carrying only a
    // booking_id and to leave missions.status untouched. Two consequences, both
    // reported as "the Bravo Control System still shows SOS 0":
    //   1. the console's live feed lists missions by status and counts
    //      status === 'SOS', so a client panic was structurally invisible;
    //   2. ack / escalate / resolve all read sos_events.mission_id, so even
    //      once seen the alert could not be worked.
    // Resolve the mission the same way the CPO path does (agent.service
    // raiseSos) and carry BOTH ids on the row.
    //
    // AUTHZ-1 — the mission flip + the crew/agency panic fan-out below are
    // booking-scoped side effects, so they MUST be bound to a booking THIS
    // caller owns. `bookingId` is a caller-supplied param; without the
    // `client_id = $2` predicate any authenticated user who knows a booking
    // UUID could flip a stranger's live mission to SOS and spam its crew.
    // The SOS row itself still records under the caller's own user_id even
    // when the id is not theirs (panic-from-anywhere intent preserved) — we
    // simply never touch a mission the caller does not own.
    const mission = args.bookingId
      ? await this.db.qOne<{id: string; status: string}>(
          `SELECT m.id, m.status FROM missions m
             JOIN lite_bookings b ON b.id = m.booking_id
            WHERE m.booking_id = $1
              AND b.client_id = $2
              AND m.status NOT IN ('COMPLETED', 'ABORTED')
            ORDER BY m.created_at DESC
            LIMIT 1`,
          [args.bookingId, userId],
        )
      : null;

    const row = await this.db.withTransaction(async tx => {
      // Conditional flip, mirroring raiseSos: two parallel panic presses must
      // not double-write, and a mission that already reads SOS stays SOS.
      if (mission && mission.status !== 'SOS') {
        // FSM-1 — the client panic raises SOS on the principal's behalf (SYSTEM actor).
        // Never throws: the mission resolve above excludes COMPLETED/ABORTED, so the from
        // is always DISPATCHED/PICKUP/LIVE — all legal SYSTEM->SOS after the reconciliation.
        missionFsm.assert(mission.status as MissionStatus, 'SOS', 'SYSTEM');
        await tx.q(
          `UPDATE missions SET status = 'SOS', updated_at = NOW()
            WHERE id = $1 AND status NOT IN ('SOS', 'COMPLETED', 'ABORTED')`,
          [mission.id],
        );
      }
      return tx.qOne<{id: string; triggered_at: Date}>(
        `INSERT INTO public.sos_events
           (user_id, booking_id, mission_id, location, status, payload, reason, lat, lng, protection_session_id)
         VALUES (
           $1, $2, $3,
           CASE WHEN $4::text IS NULL THEN NULL ELSE ST_GeogFromText($4) END,
           'active', $5::jsonb, $6, $7, $8, $9
         )
         RETURNING id, triggered_at`,
        [
          userId,
          args.bookingId ?? null,
          mission?.id ?? null,
          effPoint,
          payload,
          reason,
          effLat,
          effLng,
          psession?.id ?? null,
        ],
      );
    });
    if (!row) throw new Error('sos_insert_failed');

    // §7 — a protection-session SOS: flag the session, wake its CPO, light the
    // session room. The SOS stays owned by the sos lifecycle (§3) — ending the
    // session never resolves it, and this flag never cascades back the other way.
    if (psession) {
      await this.db.q(
        `UPDATE public.protection_sessions SET sos_active = true, updated_at = now()
          WHERE id = $1 AND status IN ('REQUESTED','ACTIVE','ENDING')`,
        [psession.id],
      ).catch(() => undefined);
      // Mission-history event (append-only canonical timeline).
      await this.db.q(
        `INSERT INTO public.protection_session_events (session_id, event_type, actor_id, actor_role, comment)
         VALUES ($1, 'sos', $2, 'customer', 'SOS raised')`,
        [psession.id, userId],
      ).catch(() => undefined);
      void this.events.broadcast(psession.id, 'psession.sos', {active: true}).catch(() => undefined);
      void this.push.psessionSos(psession.cpo_user_id, psession.id).catch(() => undefined);
    }

    // Ops live feed — surfaces under the unacknowledged badge.
    await this.opsAudit.emit({
      kind:     'sos',
      severity: 'err',
      actor:    userId,
      subject:  args.bookingId ?? row.id,
      message:  `SOS · client panic · ${reason}`,
    });
    // System audit (Kafka).
    await this.audit.emit({
      event_type: 'client.sos.raise',
      user_id:    userId,
      device_id:  null,
      ip:         'client',
      outcome:    'success',
      detail:     reason,
    });

    // Fan a wake to every CPO crewed on the booking so they see the
    // panic event without needing the live tracker mounted. Same Redis
    // channel BookingPushBridge uses; messenger-service subscribes and
    // dispatches via FCM.
    //
    // AUTHZ-1 — gate on `mission`, the OWNERSHIP-VERIFIED handle (null unless the
    // caller owns this booking's live mission), NOT the caller-supplied
    // `args.bookingId`. Gating on the bare id let any authenticated user who knows
    // a booking UUID spam false SOS pushes to that booking's crew + agency desk
    // (safety-channel alert fatigue). `mission.id`/`args.bookingId` are the same
    // booking here, so the crew/provider queries below are now owner-scoped.
    // (`mission` non-null implies `args.bookingId` is set — the extra clause is the
    // type narrowing, always true when `mission` is truthy, not a second gate.)
    if (mission && args.bookingId) {
      try {
        const crew = await this.db.q<{user_id: string; mission_id: string}>(
          // LM-B1 — skip ABORTED history missions + stood-down crew rows.
          `SELECT mc.agent_id AS user_id, m.id AS mission_id
             FROM mission_crew mc
             JOIN missions m ON m.id = mc.mission_id
            WHERE m.booking_id = $1
              AND m.status NOT IN ('COMPLETED', 'ABORTED')
              AND mc.status <> 'off'`,
          [args.bookingId],
        );
        // F5 — the AGENCY monitoring desk was blind to SOS (no push, no banner);
        // include the assigned provider org in the fan-out.
        const provider = await this.db.qOne<{assigned_provider_user_id: string | null}>(
          `SELECT assigned_provider_user_id FROM lite_bookings WHERE id = $1`,
          [args.bookingId],
        );
        // A1 SOS-WAKE-DROPPED-AT-RELAY — fan out through the OPAQUE
        // BookingPushBridge (eventId + coarse 'sos' class), NOT a hand-rolled
        // publish. The legacy payload here carried NO eventId, so the
        // messenger-service push subscriber bailed on `!frame.eventId` and the
        // panic alert never reached FCM. Group by mission so each CPO's wake
        // carries their own missionId in the encrypted detail blob.
        const byMission = new Map<string, string[]>();
        for (const c of crew) {
          const arr = byMission.get(c.mission_id) ?? [];
          arr.push(c.user_id);
          byMission.set(c.mission_id, arr);
        }
        for (const [missionId, userIds] of byMission) {
          const withProvider = provider?.assigned_provider_user_id
            ? [...new Set([...userIds, provider.assigned_provider_user_id])]
            : userIds;
          await this.push.sosAlert(withProvider, missionId, args.bookingId);
        }
      } catch (e) {
        this.log.warn(`client SOS fanout failed: ${(e as Error).message}`);
      }
    }

    return {id: row.id, triggered_at: row.triggered_at.toISOString()};
  }

  async cancel(userId: string, sosId: string): Promise<void> {
    // Only the originating user can cancel their own active SOS. Ops
    // keeps acknowledge/escalate/resolve on the ops side; cancel here
    // is the client's "false alarm" path (user releases hold-to-cancel
    // from the Lite dashboard).
    await this.db.q(
      `UPDATE public.sos_events
          SET status      = 'false_alarm',
              resolved_at = NOW(),
              resolved_by = $1
        WHERE id = $2 AND user_id = $1 AND status = 'active'`,
      [userId, sosId],
    );
    await this.audit.emit({
      event_type: 'client.sos.cancel',
      user_id:    userId,
      device_id:  null,
      ip:         'client',
      outcome:    'success',
    });
  }

  /**
   * Audit fix 0.7 (round-trip) — read the lifecycle stamps so the
   * dashboard can wait for ops's ack before showing "Ops Room On
   * Standby" (instead of optimistically lying to the user).
   *
   * Scoped to the originating user — a row from someone else's panic
   * press returns 404 even with a valid JWT.
   */
  async status(userId: string, sosId: string): Promise<SosStatusDto> {
    const row = await this.db.qOne<{
      id:              string;
      status:          string;
      triggered_at:    Date;
      acknowledged_at: Date | null;
      acknowledged_by: string | null;
      escalated_at:    Date | null;
      resolved_at:     Date | null;
    }>(
      `SELECT id, status, triggered_at,
              acknowledged_at, acknowledged_by,
              escalated_at, resolved_at
         FROM public.sos_events
        WHERE id = $1 AND user_id = $2`,
      [sosId, userId],
    );
    if (!row) throw new NotFoundException('sos_not_found');
    return {
      id:              row.id,
      status:          row.status,
      triggered_at:    row.triggered_at.toISOString(),
      acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
      acknowledged_by: row.acknowledged_by,
      escalated_at:    row.escalated_at?.toISOString() ?? null,
      resolved_at:     row.resolved_at?.toISOString() ?? null,
    };
  }
}
