import {Injectable, Logger} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {AuditService} from '../kafka/audit.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {SmsService} from '../common/services/sms.service';

export interface Geofence {
  id:     string;
  name:   string;
  kind:   'safe' | 'danger';
  active: boolean;
}

// Zone state we compare against the previous fix to detect a transition.
// 'in_danger' | 'outside_safe' are the breach states; 'ok' is normal.
type ZoneState = 'ok' | 'in_danger' | 'outside_safe';

/**
 * BE-7.3 — server-side geofence evaluation via PostGIS polygon
 * containment. Called on every telemetry fix. A BREACH (entered a danger
 * zone, or left every safe zone) fans out: Kafka escalation-events, an
 * Ops live-feed row, a WS `vbg.breach`, and an SMS — but only on the
 * STATE TRANSITION, so a stationary principal doesn't spam.
 */
@Injectable()
export class GeofenceService {
  private readonly log = new Logger(GeofenceService.name);

  // Audit M-6 — evaluate() runs on every 3s telemetry tick; users with zero
  // zones must not pay 4 queries per tick. Cached active-zone counts, 60s
  // TTL, invalidated on zone create/delete.
  private static readonly ZONE_COUNT_TTL_MS = 60_000;
  private readonly zoneCount = new Map<string, {at: number; count: number}>();

  constructor(
    private readonly db:       DatabaseService,
    private readonly audit:    AuditService,
    private readonly opsAudit: OpsAuditService,
    private readonly events:   MissionEventsService,
    private readonly sms:      SmsService,
  ) {}

  private async activeZoneCount(userId: string): Promise<number> {
    const hit = this.zoneCount.get(userId);
    if (hit && Date.now() - hit.at < GeofenceService.ZONE_COUNT_TTL_MS) {return hit.count;}
    const row = await this.db.qOne<{n: number}>(
      'SELECT COUNT(*)::int AS n FROM public.vbg_geofences WHERE user_id = $1 AND active',
      [userId],
    );
    const count = row?.n ?? 0;
    this.zoneCount.set(userId, {at: Date.now(), count});
    return count;
  }

  async listZones(userId: string): Promise<Geofence[]> {
    return this.db.q<Geofence>(
      `SELECT id, name, kind, active FROM public.vbg_geofences
        WHERE user_id = $1 AND active ORDER BY created_at DESC`,
      [userId],
    );
  }

  /**
   * Create a zone from a GeoJSON-ish ring of [lng,lat] points. The ring is
   * closed server-side and built into an EWKT POLYGON literal — the
   * coordinates are re-validated as finite numbers before interpolation so
   * nothing non-numeric reaches the SQL text (same defense as SosService).
   */
  async createZone(
    userId: string,
    args: {name: string; kind: 'safe' | 'danger'; ring: Array<[number, number]>},
  ): Promise<{id: string}> {
    const pts = args.ring.filter(p => Array.isArray(p) && p.length === 2
      && Number.isFinite(p[0]) && Number.isFinite(p[1])
      && p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90);
    if (pts.length < 3) {throw new Error('a geofence ring needs at least 3 valid points');}
    // Close the ring if the caller didn't.
    const first = pts[0]; const last = pts[pts.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {pts.push(first);}
    const ewkt = `SRID=4326;POLYGON((${pts.map(([lng, lat]) => `${Number(lng)} ${Number(lat)}`).join(', ')}))`;
    const row = await this.db.qOne<{id: string}>(
      `INSERT INTO public.vbg_geofences (user_id, name, kind, area)
       VALUES ($1, $2, $3, ST_GeogFromText($4))
       RETURNING id`,
      [userId, args.name.slice(0, 80), args.kind === 'danger' ? 'danger' : 'safe', ewkt],
    );
    if (!row) {throw new Error('geofence_insert_failed');}
    // The zone set changed: drop the cached count and reset the transition
    // state so a stale pre-change state can't mask the first real breach.
    this.zoneCount.delete(userId);
    await this.db.q('UPDATE public.vbg_monitoring SET last_zone_state = \'ok\' WHERE user_id = $1', [userId]).catch(() => undefined);
    return {id: row.id};
  }

  async deleteZone(userId: string, id: string): Promise<void> {
    await this.db.q(
      'UPDATE public.vbg_geofences SET active = FALSE WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    this.zoneCount.delete(userId);
    await this.db.q('UPDATE public.vbg_monitoring SET last_zone_state = \'ok\' WHERE user_id = $1', [userId]).catch(() => undefined);
  }

  /**
   * Evaluate a fix against the user's active zones. Returns the breach (if
   * any) and fires the escalation fan-out on a state transition.
   *
   * `getPhones` resolves the SMS recipients lazily — only a breach pays the
   * favorites lookup (audit H-4/M-6).
   */
  async evaluate(
    userId: string,
    fix: {lat: number; lng: number},
    getPhones?: () => Promise<string[]>,
  ): Promise<{state: ZoneState; breached: boolean; zone?: Geofence}> {
    // No zones → nothing to evaluate; skip the PostGIS + state queries
    // entirely (audit M-6 — this path runs on every telemetry tick).
    if ((await this.activeZoneCount(userId)) === 0) {
      return {state: 'ok', breached: false};
    }
    const pt = `SRID=4326;POINT(${Number(fix.lng)} ${Number(fix.lat)})`;

    // Danger zone the point is inside (if any).
    const inDanger = await this.db.qOne<Geofence>(
      `SELECT id, name, kind, active FROM public.vbg_geofences
        WHERE user_id = $1 AND active AND kind = 'danger'
          AND ST_Contains(area::geometry, ST_GeogFromText($2)::geometry)
        LIMIT 1`,
      [userId, pt],
    );

    // Does the user have any safe zones, and is the point inside one?
    const safe = await this.db.qOne<{total: number; inside: number}>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE ST_Contains(area::geometry, ST_GeogFromText($2)::geometry))::int AS inside
       FROM public.vbg_geofences
       WHERE user_id = $1 AND active AND kind = 'safe'`,
      [userId, pt],
    );

    let state: ZoneState = 'ok';
    let zone: Geofence | undefined;
    if (inDanger) {
      state = 'in_danger';
      zone = inDanger;
    } else if (safe && safe.total > 0 && safe.inside === 0) {
      state = 'outside_safe';
    }

    // Transition check — only escalate when the state changed.
    const prev = await this.db.qOne<{last_zone_state: string | null}>(
      'SELECT last_zone_state FROM public.vbg_monitoring WHERE user_id = $1',
      [userId],
    );
    const prevState = (prev?.last_zone_state ?? 'ok') as ZoneState;
    await this.db.q(
      'UPDATE public.vbg_monitoring SET last_zone_state = $2 WHERE user_id = $1',
      [userId, state],
    );

    const breached = state !== 'ok' && state !== prevState;
    if (breached) {
      const phones = getPhones ? await getPhones().catch(() => [] as string[]) : [];
      await this.fanOutBreach(userId, state, fix, zone, phones);
    }
    return {state, breached, zone};
  }

  private async fanOutBreach(
    userId: string,
    state: ZoneState,
    fix: {lat: number; lng: number},
    zone: Geofence | undefined,
    phones: string[],
  ): Promise<void> {
    const detail = state === 'in_danger'
      ? `Entered danger zone${zone ? ` "${zone.name}"` : ''}`
      : 'Left safe area';
    this.log.warn(`geofence breach user=${userId.slice(0, 8)} state=${state}`);

    // Kafka escalation-events.
    await this.audit.emitEscalation({
      type: 'geofence_breach', user_id: userId, detail, lat: fix.lat, lng: fix.lng, zone_id: zone?.id,
    }).catch(() => undefined);

    // Ops live feed.
    await this.opsAudit.emit({
      kind: 'sos', severity: 'warn', actor: userId, subject: zone?.id ?? userId,
      message: `VBG · geofence breach · ${detail}`,
    }).catch(() => undefined);

    // WS to ops + the principal's devices (vbg:<userId> room).
    await this.events.broadcast(`vbg:${userId}`, 'mission.status', {
      kind: 'vbg.breach', state, detail, lat: fix.lat, lng: fix.lng,
    }).catch(() => undefined);

    // SMS the Next-of-Kin favorites (fallback: principal) — audit H-4.
    for (const phone of phones) {
      void this.sms.sendSms(phone, `Bravo Secure alert: ${detail}. Ops Room notified.`);
    }
  }
}
