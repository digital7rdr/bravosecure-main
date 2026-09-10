import {Injectable, Logger} from '@nestjs/common';
import {RedisService} from '../redis/redis.service';

/**
 * Audit fix 5.1 — broadcast mission lifecycle changes to the messenger
 * gateway via Redis pub/sub.
 *
 * The messenger gateway already runs socket.io with a Redis adapter; we
 * piggyback that same Redis instance for one additional channel,
 * `mission:events`. The gateway subscribes and re-emits each frame to
 * the matching `mission:<id>` socket.io room. Mobile + ops console
 * subscribe to that room (via the existing WS) instead of polling.
 *
 * Why pub/sub and not a direct HTTP call from auth-service →
 * messenger-service:
 *   - Auth-service already publishes other side-effects this way
 *     (envelope acks, presence). Adding a second transport is churn.
 *   - Redis is fan-out free; multi-pod messenger deployments all
 *     receive the broadcast without auth-service knowing how many
 *     pods exist.
 *   - A delivery miss (gateway down for 200ms) doesn't fail the
 *     auth-service mutation — pub/sub is fire-and-forget, fallback to
 *     the original polling loop on the client kicks in.
 *
 * Event shape kept narrow on purpose:
 *   - `mission.status`    — FSM transition
 *   - `mission.team`      — crew roster changed
 *   - `mission.telemetry` — new GPS fix
 * Bodies are summaries, not full rows. Clients use the event as a
 * cache-invalidation trigger and re-fetch via REST. That keeps the
 * pub/sub channel cheap and avoids re-implementing the auth surface
 * (region scoping, JWT) twice.
 */
@Injectable()
export class MissionEventsService {
  private readonly log = new Logger(MissionEventsService.name);
  static readonly CHANNEL = 'mission:events';

  constructor(private readonly redis: RedisService) {}

  async broadcast(missionId: string, event: MissionEvent, data: Record<string, unknown> = {}): Promise<void> {
    const payload = JSON.stringify({missionId, event, data, ts: Date.now()});
    try {
      await this.redis.client.publish(MissionEventsService.CHANNEL, payload);
    } catch (e) {
      // Never throw — clients fall back to polling on a missed event.
      this.log.warn(`mission events publish failed: ${(e as Error).message}`);
    }
  }

  /**
   * Broadcast on a booking room too. Mobile clients hold the bookingId
   * (it's the navigation param), not the missionId — exposing both keys
   * lets either side subscribe with whichever they have. The gateway
   * accepts any `mission:<id>` key and joins the socket to that room.
   */
  async broadcastBoth(missionId: string, bookingId: string | null, event: MissionEvent, data: Record<string, unknown> = {}): Promise<void> {
    await this.broadcast(missionId, event, data);
    if (bookingId) {
      // The "mission" channel name is preserved on the wire so the
      // gateway treats both keys identically — fan-out is identical
      // to the missionId path.
      const payload = JSON.stringify({missionId: bookingId, event, data, ts: Date.now()});
      try {
        await this.redis.client.publish(MissionEventsService.CHANNEL, payload);
      } catch (e) {
        this.log.warn(`mission events publish (booking) failed: ${(e as Error).message}`);
      }
    }
  }

  /** Convenience helpers — keep the call sites at the FSM boundaries terse. */
  async statusChanged(missionId: string, status: string, bookingId?: string | null): Promise<void> {
    return this.broadcastBoth(missionId, bookingId ?? null, 'mission.status', {status});
  }
  async teamChanged(missionId: string, bookingId?: string | null): Promise<void> {
    return this.broadcastBoth(missionId, bookingId ?? null, 'mission.team', {});
  }
  async telemetryFix(
    missionId: string,
    // MG-01/MG-14 — heading/speed/accuracy/ETA ride the frame so the
    // client can rotate the marker + draw a confidence circle without a
    // REST round-trip; all optional to stay wire-compatible.
    fix: {
      lat: number; lng: number; recordedAt: string;
      heading_deg?: number; speed_kph?: number; accuracy_m?: number; eta_minutes?: number;
    },
    bookingId?: string | null,
  ): Promise<void> {
    return this.broadcastBoth(missionId, bookingId ?? null, 'mission.telemetry', fix);
  }
}

export type MissionEvent =
  | 'mission.status' | 'mission.team' | 'mission.telemetry'
  // Bravo Secure Pro applications ride the same Redis lane + gateway rooms:
  // the room key is the APPLICATION id (`mission:<applicationId>`), which the
  // gateway treats like any other unguessable-UUID room key.
  | 'proapp.status' | 'proapp.message'
  // Protection sessions (spec §4): room key = protection SESSION id. Payloads are
  // TRIGGERS-TO-REFETCH, never coordinates — `psession.location` carries only a
  // server `ts`; the CPO/Ops client refetches the trail via the AUDITED REST poll
  // (§9: every coordinate read writes protection_access_audit; a WS coord payload
  // would have no per-access audit). `psession.status`/`psession.sos` carry a
  // coarse status/flag only.
  | 'psession.status' | 'psession.location' | 'psession.sos' | 'psession.note'
  | 'psession.readiness';
