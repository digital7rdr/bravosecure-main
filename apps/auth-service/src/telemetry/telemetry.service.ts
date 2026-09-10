import {Injectable, Logger, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';

export interface TelemetryFix {
  lat: number;
  lng: number;
  heading_deg?: number;
  speed_kph?: number;
  eta_minutes?: number;
  recorded_at: string;
  source: string;
}

/**
 * Mission telemetry — GPS fixes written by the assigned CPO agent, read by
 * the client's LiveTracking screen.
 *
 * Storage:
 *   - Redis Stream `telemetry:{bookingId}`  → primary, capped via MAXLEN.
 *   - `mission_telemetry_last`              → single-row Postgres fallback so
 *     the REST `latest` endpoint survives Redis restarts.
 *
 * When we introduce a WS gateway in Phase 2, consumers subscribe to the
 * stream instead of polling `/latest`.
 */
@Injectable()
export class TelemetryService {
  private readonly log = new Logger(TelemetryService.name);
  private readonly streamMaxLen: number;
  private readonly streamTtlSec: number;

  constructor(
    private readonly redis: RedisService,
    private readonly db: DatabaseService,
    cfg: ConfigService,
  ) {
    this.streamMaxLen = cfg.get<number>('telemetry.streamMaxLen') ?? 500;
    this.streamTtlSec = cfg.get<number>('telemetry.streamTtlSec') ?? 86_400;
  }

  /** Agent → server: append a fix. Returns what was stored (normalised). */
  async ping(bookingId: string, fix: {
    lat: number;
    lng: number;
    heading_deg?: number;
    speed_kph?: number;
    eta_minutes?: number;
    source?: string;
    recorded_at?: string;
  }): Promise<TelemetryFix> {
    await this.assertBookingExists(bookingId);
    const recordedAt = fix.recorded_at ?? new Date().toISOString();
    const normalised: TelemetryFix = {
      lat: fix.lat,
      lng: fix.lng,
      heading_deg: fix.heading_deg,
      speed_kph: fix.speed_kph,
      eta_minutes: fix.eta_minutes,
      source: fix.source ?? 'agent',
      recorded_at: recordedAt,
    };

    // Redis Stream — primary source for WS gateway.
    const entries: string[] = [
      'lat', String(normalised.lat),
      'lng', String(normalised.lng),
      'recorded_at', normalised.recorded_at,
      'source', normalised.source,
    ];
    if (normalised.heading_deg != null) entries.push('heading_deg', String(normalised.heading_deg));
    if (normalised.speed_kph   != null) entries.push('speed_kph',   String(normalised.speed_kph));
    if (normalised.eta_minutes != null) entries.push('eta_minutes', String(normalised.eta_minutes));

    const key = this.streamKey(bookingId);
    try {
      await this.redis.client.xadd(key, 'MAXLEN', '~', String(this.streamMaxLen), '*', ...entries);
      await this.redis.client.expire(key, this.streamTtlSec);
    } catch (e) {
      this.log.warn(`redis xadd failed for ${bookingId}: ${(e as Error).message}`);
    }

    // Postgres fallback — UPSERT so `/latest` always works.
    await this.db.q(
      `INSERT INTO mission_telemetry_last
         (booking_id, lat, lng, heading_deg, speed_kph, eta_minutes, recorded_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (booking_id) DO UPDATE SET
         lat = EXCLUDED.lat,
         lng = EXCLUDED.lng,
         heading_deg = EXCLUDED.heading_deg,
         speed_kph   = EXCLUDED.speed_kph,
         eta_minutes = EXCLUDED.eta_minutes,
         recorded_at = EXCLUDED.recorded_at,
         source      = EXCLUDED.source`,
      [
        bookingId,
        normalised.lat,
        normalised.lng,
        normalised.heading_deg ?? null,
        normalised.speed_kph   ?? null,
        normalised.eta_minutes ?? null,
        recordedAt,
        normalised.source,
      ],
    );

    return normalised;
  }

  /** Client → server: read the latest fix. Prefers Redis, falls back to Postgres. */
  async latest(bookingId: string): Promise<TelemetryFix | null> {
    const key = this.streamKey(bookingId);
    try {
      const rows = await this.redis.client.xrevrange(key, '+', '-', 'COUNT', 1);
      if (rows && rows.length > 0) {
        const [, fields] = rows[0] as unknown as [string, string[]];
        return this.fieldsToFix(fields);
      }
    } catch (e) {
      this.log.warn(`redis xrevrange failed for ${bookingId}: ${(e as Error).message}`);
    }

    const row = await this.db.qOne<{
      lat: number; lng: number; heading_deg: number | null; speed_kph: number | null;
      eta_minutes: number | null; recorded_at: Date; source: string;
    }>(
      `SELECT lat, lng, heading_deg, speed_kph, eta_minutes, recorded_at, source
         FROM mission_telemetry_last
        WHERE booking_id = $1`,
      [bookingId],
    );
    if (!row) return null;
    return {
      lat: Number(row.lat),
      lng: Number(row.lng),
      heading_deg: row.heading_deg ?? undefined,
      speed_kph:   row.speed_kph   ?? undefined,
      eta_minutes: row.eta_minutes ?? undefined,
      recorded_at: new Date(row.recorded_at).toISOString(),
      source: row.source,
    };
  }

  /** Client → server: read a short recent window (e.g. for a trail). */
  async recent(bookingId: string, count = 60): Promise<TelemetryFix[]> {
    const key = this.streamKey(bookingId);
    try {
      const rows = await this.redis.client.xrevrange(key, '+', '-', 'COUNT', Math.min(count, 200));
      return (rows ?? []).map(([, fields]) => this.fieldsToFix(fields as string[])).reverse();
    } catch (e) {
      this.log.warn(`redis xrevrange(history) failed for ${bookingId}: ${(e as Error).message}`);
      const latest = await this.latest(bookingId);
      return latest ? [latest] : [];
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private streamKey(bookingId: string): string {
    return `telemetry:${bookingId}`;
  }

  private async assertBookingExists(bookingId: string): Promise<void> {
    const row = await this.db.qOne<{id: string}>(
      `SELECT id FROM lite_bookings WHERE id = $1`,
      [bookingId],
    );
    if (!row) throw new NotFoundException('booking_not_found');
  }

  private fieldsToFix(fields: string[]): TelemetryFix {
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      map[fields[i]] = fields[i + 1];
    }
    return {
      lat: Number(map.lat),
      lng: Number(map.lng),
      heading_deg: map.heading_deg != null ? Number(map.heading_deg) : undefined,
      speed_kph:   map.speed_kph   != null ? Number(map.speed_kph)   : undefined,
      eta_minutes: map.eta_minutes != null ? Number(map.eta_minutes) : undefined,
      recorded_at: map.recorded_at ?? new Date().toISOString(),
      source: map.source ?? 'agent',
    };
  }
}
