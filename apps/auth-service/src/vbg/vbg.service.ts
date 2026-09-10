import {BadRequestException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit} from '@nestjs/common';
import {fetchWithDeadline} from '../common/http/fetchWithDeadline';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {AuditService} from '../kafka/audit.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {SosService} from '../sos/sos.service';
import {SmsService} from '../common/services/sms.service';
import {GeocodeService} from './geocode.service';
import {GdeltService, type ThreatItem} from './gdelt.service';
import {NewsDataService} from './newsdata.service';
import {GoogleNewsService} from './googlenews.service';
import {isLocallyRelevant} from './countryNames';
import {osintDomainsFor} from './osintSources';
import {GeofenceService} from './geofence.service';
import {generateTelemetryKeyB64, openTelemetry} from './telemetryCrypto';

export interface MonitoringStatusDto {
  enrolled:          boolean;
  status:            string | null;
  interval_min:      number | null;
  enrolled_at:       string | null;
  last_heartbeat_at: string | null;
  missed_count:      number;
  /** True when the current window has lapsed past the missed threshold. */
  overdue:           boolean;
}

/** A news item backing a risk category, surfaced when the user taps it. */
export interface RiskArticle {
  title:    string;
  url:      string;
  source:   string;
  seenAt:   string;
  severity: 'critical' | 'caution' | 'information';
}

export interface SraSnapshotDto {
  region:          string;            // resolved place name, e.g. "Benoni"
  context:         string;            // "Gauteng, South Africa"
  risk_score:      number;            // 0..100
  level:           'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary:         string;
  /** Each risk carries the live news articles that back it, for the
   *  tap-to-read-news drilldown on the GeoRisk screen. */
  risks:           Array<{name: string; level: 'low' | 'medium' | 'high'; articles: RiskArticle[]}>;
  recommendations: string[];
  /** Count of live region threats backing the score, by severity. */
  counts:          {critical: number; caution: number; information: number};
  lat:             number | null;
  lng:             number | null;
  created_at:      string;
}

export interface RegionThreatsDto {
  region:  string;
  context: string;
  /** ISO-3166 alpha-2 of the reverse-geocoded country (emergency-number pinning). */
  country: string | null;
  threats: ThreatItem[];
  counts:  {critical: number; caution: number; information: number};
}

export interface KeyPoint {
  kind:    'police' | 'hospital' | 'embassy' | 'fire';
  label:   string;
  lat:     number;
  lng:     number;
  /** Great-circle distance from the query point, in kilometres. */
  distanceKm: number;
}

/** BE-7.6 — a saved "Next of Kin" emergency contact. */
export interface FavoriteDtoOut {
  id:       string;
  name:     string;
  phone:    string;
  position: number;
}

const DEFAULT_INTERVAL_MIN = 60;
// Three consecutive missed windows trips escalation — mirrors the SRA
// screen copy ("If 3 scans are missed"). Kept as a multiplier on the
// enrolled interval so a 60-min cadence escalates after ~180 min silent.
const MISSED_WINDOWS_BEFORE_ESCALATION = 3;

// Mapbox category search terms per key-point kind (fallback source).
const KEYPOINT_QUERIES: Array<{kind: KeyPoint['kind']; q: string}> = [
  {kind: 'police',   q: 'police station'},
  {kind: 'hospital', q: 'hospital'},
  {kind: 'embassy',  q: 'embassy'},
  {kind: 'fire',     q: 'fire station'},
];

// Generic label per kind when an OSM node has no name tag.
const KEYPOINT_LABEL: Record<KeyPoint['kind'], string> = {
  police: 'Police Station', hospital: 'Hospital', embassy: 'Embassy', fire: 'Fire Station',
};

/** Map an OSM node's tags → one of our 4 key-point kinds (or null to skip). */
function osmKind(tags: Record<string, string>): KeyPoint['kind'] | null {
  const a = tags.amenity;
  if (a === 'police') {return 'police';}
  if (a === 'hospital' || a === 'clinic') {return 'hospital';}
  if (a === 'fire_station') {return 'fire';}
  if (tags.office === 'diplomatic' || tags.diplomatic) {return 'embassy';}
  return null;
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)) * 10) / 10;
}

/**
 * VBG (Virtual Bodyguard) service.
 *
 * Region-aware, GPS-driven: a fix is reverse-geocoded (Mapbox) to a place
 * name, live regional threats are pulled from GDELT, and the SRA score +
 * nearby key points are computed from real data for that location — no
 * hardcoded city.
 *
 * Also owns biometric *liveness* monitoring (a duress heartbeat, NOT the
 * device auth gate). Missed-scan escalation reuses the existing
 * `SosService.raise` — the same Ops-Room path the panic button fires.
 */
@Injectable()
export class VbgService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(VbgService.name);
  private readonly mapboxToken: string | undefined =
    process.env.MAPBOX_ACCESS_TOKEN
    ?? process.env.NEXT_PUBLIC_MAPBOX_TOKEN
    ?? process.env.EXPO_PUBLIC_MAPBOX_TOKEN;

  constructor(
    private readonly db:       DatabaseService,
    private readonly redis:    RedisService,
    private readonly audit:    AuditService,
    private readonly events:   MissionEventsService,
    private readonly sos:      SosService,
    private readonly sms:      SmsService,
    private readonly geocode:  GeocodeService,
    private readonly gdelt:      GdeltService,
    private readonly geofence:   GeofenceService,
    private readonly newsdata:   NewsDataService,
    private readonly googlenews: GoogleNewsService,
  ) {}

  // ── BE-7.1 telemetry stream (Redis) ───────────────────────────────────────
  // 3000 entries at the ~30s stream cadence ≈ 25h of trail, which makes the
  // Location History sheet's "last 24 hours" claim true (audit M-2).
  private static readonly STREAM_MAXLEN = 3_000;
  private static readonly STREAM_TTL_SEC = 86_400;
  // Stream writes are downsampled to one per 30s per user (the durable
  // last-fix row still updates on every tick) so the capped stream holds a
  // day of history instead of ~25 minutes of 3s pings.
  private static readonly STREAM_MIN_INTERVAL_MS = 30_000;
  private readonly lastStreamWriteAt = new Map<string, number>();
  private streamKey(userId: string): string { return `vbg:telemetry:${userId}`; }

  // ── H-1 — missed-scan watchdog ────────────────────────────────────────────
  private static readonly WATCHDOG_INTERVAL_MS = 60_000;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogRunning = false;

  onModuleInit(): void {
    // The escalation promise ("3 missed scans → Ops Room") must not depend on
    // the principal's phone ever calling home again — sweep server-side.
    this.watchdogTimer = setInterval(() => { void this.sweepOverdueMonitoring(); }, VbgService.WATCHDOG_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.watchdogTimer) {clearInterval(this.watchdogTimer);}
  }

  /**
   * Escalate every active enrollment whose heartbeat window lapsed past the
   * missed threshold. `escalated_at` marks the silent window as handled so a
   * still-silent principal isn't re-escalated every sweep — a fresh heartbeat
   * (which resets `last_heartbeat_at`) re-arms the watchdog.
   */
  async sweepOverdueMonitoring(): Promise<number> {
    if (this.watchdogRunning) {return 0;}
    this.watchdogRunning = true;
    try {
      const rows = await this.db.q<{user_id: string; missed_count: number; lat: number | null; lng: number | null}>(
        `SELECT user_id, missed_count, lat, lng
           FROM public.vbg_monitoring
          WHERE status = 'active'
            AND last_heartbeat_at IS NOT NULL
            AND last_heartbeat_at < NOW() - (interval_min * ${MISSED_WINDOWS_BEFORE_ESCALATION} || ' minutes')::interval
            AND (escalated_at IS NULL OR escalated_at < last_heartbeat_at)`,
        [],
      );
      for (const row of rows) {
        try {
          await this.db.q(
            `UPDATE public.vbg_monitoring
                SET escalated_at = NOW(), missed_count = missed_count + 1
              WHERE user_id = $1`,
            [row.user_id],
          );
          const phones = await this.escalationPhones(row.user_id);
          await this.sos.raise(row.user_id, {
            lat: row.lat ?? undefined, lng: row.lng ?? undefined,
            reason: 'vbg_biometric_missed',
            payload: {source: 'vbg_watchdog', missed_count: row.missed_count + 1},
          });
          await Promise.allSettled([
            this.audit.emitEscalation({type: 'biometric_missed', user_id: row.user_id, detail: 'watchdog: heartbeat window lapsed', lat: row.lat ?? undefined, lng: row.lng ?? undefined}),
            this.events.broadcast(`vbg:${row.user_id}`, 'mission.status', {kind: 'vbg.biometric.escalation', source: 'watchdog'}),
            ...phones.map(p => this.sms.sendSms(p, 'Bravo Secure: scheduled check-ins were missed. Ops Room has been dispatched.')),
          ]);
        } catch (e) {
          this.log.error(`vbg watchdog escalation failed for ${row.user_id.slice(0, 8)}: ${(e as Error).message}`);
        }
      }
      return rows.length;
    } catch (e) {
      this.log.warn(`vbg watchdog sweep failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.watchdogRunning = false;
    }
  }

  /**
   * H-4 — who gets the escalation SMS: the saved Next-of-Kin favorites
   * (that's what they exist for), falling back to the principal's own phone
   * only when no favorites are saved.
   */
  async escalationPhones(userId: string): Promise<string[]> {
    try {
      const rows = await this.db.q<{phone_e164: string}>(
        `SELECT phone_e164 FROM public.vbg_favorites
          WHERE user_id = $1 ORDER BY position ASC LIMIT 3`,
        [userId],
      );
      const kin = rows.map(r => r.phone_e164).filter(Boolean);
      if (kin.length > 0) {return kin;}
    } catch (e) {
      this.log.warn(`escalationPhones favorites lookup failed: ${(e as Error).message}`);
    }
    const own = await this.contactPhone(userId);
    return own ? [own] : [];
  }

  async enrollMonitoring(
    userId: string,
    args: {intervalMin?: number; lat?: number; lng?: number; deviceId?: string},
  ): Promise<MonitoringStatusDto & {telemetryKeyB64?: string}> {
    const interval = args.intervalMin ?? DEFAULT_INTERVAL_MIN;
    const isFiniteLat = typeof args.lat === 'number' && Number.isFinite(args.lat);
    const isFiniteLng = typeof args.lng === 'number' && Number.isFinite(args.lng);

    // Upsert on the unique user_id — re-enrolling refreshes the cadence
    // and resets the missed counter without creating a duplicate row.
    await this.db.q(
      `INSERT INTO public.vbg_monitoring
         (user_id, interval_min, status, enrolled_at, last_heartbeat_at, missed_count, lat, lng)
       VALUES ($1, $2, 'active', NOW(), NOW(), 0, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET interval_min      = EXCLUDED.interval_min,
             status            = 'active',
             last_heartbeat_at = NOW(),
             missed_count      = 0,
             consecutive_fails = 0,
             lat               = COALESCE(EXCLUDED.lat, public.vbg_monitoring.lat),
             lng               = COALESCE(EXCLUDED.lng, public.vbg_monitoring.lng)`,
      [userId, interval, isFiniteLat ? args.lat : null, isFiniteLng ? args.lng : null],
    );

    // BE-7 — mint + persist the per-device AES-256 telemetry key and hand
    // it back ONCE so the device can store it in its keychain. Re-enroll
    // rotates the key. Only issued when a deviceId is supplied.
    // Why the key is plaintext at rest (audit L-7): the server IS the trusted
    // decryptor in this design (it must read coords for the PostGIS geofence
    // check) — this is transport encryption, not E2EE. DB compromise ⇒ key
    // compromise is accepted; revisit with pgcrypto/KMS if that changes.
    let telemetryKeyB64: string | undefined;
    if (args.deviceId) {
      telemetryKeyB64 = generateTelemetryKeyB64();
      await this.db.q(
        `INSERT INTO public.vbg_device_keys (user_id, device_id, key_b64, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, device_id) DO UPDATE SET key_b64 = EXCLUDED.key_b64, created_at = NOW()`,
        [userId, args.deviceId, telemetryKeyB64],
      );
    }

    const status = await this.monitoringStatus(userId);
    return {...status, telemetryKeyB64};
  }

  // ── BE-7.1 — Telemetry ingest (encrypted body) + geofence eval + WS ───────
  async ingestTelemetry(
    userId: string,
    deviceId: string,
    sealedB64: string,
  ): Promise<{ok: true; breach: boolean}> {
    const keyRow = await this.db.qOne<{key_b64: string}>(
      'SELECT key_b64 FROM public.vbg_device_keys WHERE user_id = $1 AND device_id = $2',
      [userId, deviceId],
    );
    // Client errors are 400s, not 500s (audit M-4) — an unenrolled device or
    // tampered blob is the caller's fault and must not page on-call.
    if (!keyRow) {throw new BadRequestException('telemetry key not enrolled for this device');}

    let fix: {lat: number; lng: number; heading?: number; speed?: number; recordedAt?: string};
    try {
      // AAD binds the blob to this user (audit M-5); legacy clients that seal
      // without AAD are still accepted via the fallback inside openTelemetry.
      fix = JSON.parse(openTelemetry(sealedB64, keyRow.key_b64, telemetryAad(userId)));
    } catch {
      // Bad ciphertext / wrong key / tampered tag — reject without leaking.
      throw new BadRequestException('telemetry decrypt failed');
    }
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) {
      throw new BadRequestException('telemetry coords invalid');
    }
    // recordedAt is client-advisory: outside a sane window (clock drift,
    // replayed blob) the server's clock wins (audit M-5).
    const recordedAt = clampRecordedAt(fix.recordedAt);

    // Hot path: Redis stream (capped). Plaintext coords live only here +
    // the last-fix row — never logged. Writes are downsampled to ~30s so the
    // capped stream covers a full day (audit M-2).
    const lastWrite = this.lastStreamWriteAt.get(userId) ?? 0;
    if (Date.now() - lastWrite >= VbgService.STREAM_MIN_INTERVAL_MS) {
      const entries: string[] = ['lat', String(fix.lat), 'lng', String(fix.lng), 'recorded_at', recordedAt];
      if (Number.isFinite(fix.heading)) {entries.push('heading_deg', String(fix.heading));}
      if (Number.isFinite(fix.speed))   {entries.push('speed_kph',   String(fix.speed));}
      try {
        await this.redis.client.xadd(this.streamKey(userId), 'MAXLEN', '~', String(VbgService.STREAM_MAXLEN), '*', ...entries);
        await this.redis.client.expire(this.streamKey(userId), VbgService.STREAM_TTL_SEC);
        this.lastStreamWriteAt.set(userId, Date.now());
      } catch (e) {
        this.log.warn(`vbg telemetry xadd failed: ${(e as Error).message}`);
      }
    }

    // Durable last-fix.
    await this.db.q(
      `INSERT INTO public.vbg_telemetry_last (user_id, lat, lng, heading_deg, speed_kph, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         lat = EXCLUDED.lat, lng = EXCLUDED.lng,
         heading_deg = EXCLUDED.heading_deg, speed_kph = EXCLUDED.speed_kph,
         recorded_at = EXCLUDED.recorded_at`,
      [userId, fix.lat, fix.lng, fix.heading ?? null, fix.speed ?? null, recordedAt],
    );

    // WS fan-out to the principal's own devices + ops live map.
    await this.events.broadcast(`vbg:${userId}`, 'mission.telemetry', {
      lat: fix.lat, lng: fix.lng, recordedAt,
    }).catch(() => undefined);

    // BE-7.3 — geofence evaluation (fires breach escalation on transition).
    // Phones resolve lazily — only a breach pays the favorites lookup (H-4).
    const result = await this.geofence.evaluate(
      userId, {lat: fix.lat, lng: fix.lng}, () => this.escalationPhones(userId),
    );
    return {ok: true, breach: result.breached};
  }

  // ── BE-7.2 — recent GPS track ─────────────────────────────────────────────
  async track(userId: string, sinceSec = 600): Promise<Array<{lat: number; lng: number; recordedAt: string}>> {
    try {
      const minId = `${Date.now() - sinceSec * 1000}-0`;
      const rows = await this.redis.client.xrange(this.streamKey(userId), minId, '+');
      return (rows as Array<[string, string[]]>).map(([, f]) => {
        const m: Record<string, string> = {};
        for (let i = 0; i < f.length; i += 2) {m[f[i]] = f[i + 1];}
        return {lat: Number(m.lat), lng: Number(m.lng), recordedAt: m.recorded_at};
      }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    } catch {
      const last = await this.db.qOne<{lat: number; lng: number; recorded_at: Date}>(
        'SELECT lat, lng, recorded_at FROM public.vbg_telemetry_last WHERE user_id = $1',
        [userId],
      );
      return last ? [{lat: last.lat, lng: last.lng, recordedAt: last.recorded_at.toISOString()}] : [];
    }
  }

  // ── BE-7.1 — Panic: SOS + SMS + WS, all within the request ────────────────
  async panic(
    userId: string,
    args: {lat?: number; lng?: number},
  ): Promise<{id: string; triggered_at: string}> {
    // Reuse the proven SOS path (Ops feed + Kafka audit + crew push).
    const res = await this.sos.raise(userId, {
      lat: args.lat, lng: args.lng, reason: 'vbg_panic', payload: {source: 'vbg'},
    });
    // SMS targets the Next-of-Kin favorites (fallback: the principal) — H-4.
    const phones = await this.escalationPhones(userId);
    // Escalation topic + WS + SMS, in parallel, best-effort.
    await Promise.allSettled([
      this.audit.emitEscalation({type: 'panic', user_id: userId, lat: args.lat, lng: args.lng}),
      this.events.broadcast(`vbg:${userId}`, 'mission.status', {kind: 'vbg.panic', lat: args.lat, lng: args.lng}),
      ...phones.map(p => this.sms.sendSms(p, 'Bravo Secure: PANIC raised. Ops Room and emergency contacts have been alerted.')),
    ]);
    return res;
  }

  /**
   * Record a successful face scan. If the window since the last
   * heartbeat lapsed past the missed threshold, escalate to the Ops Room
   * via SOS BEFORE clearing the counter — a late "I'm fine" tap still
   * leaves an auditable duress trail.
   */
  async heartbeat(
    userId: string,
    args: {lat?: number; lng?: number},
  ): Promise<MonitoringStatusDto> {
    const row = await this.db.qOne<{
      interval_min: number;
      last_heartbeat_at: Date | null;
      missed_count: number;
      status: string;
    }>(
      `SELECT interval_min, last_heartbeat_at, missed_count, status
         FROM public.vbg_monitoring
        WHERE user_id = $1`,
      [userId],
    );

    if (!row || row.status !== 'active') {
      // Not enrolled (or paused) — a heartbeat is a no-op rather than an
      // error so the client can fire optimistically.
      return this.monitoringStatus(userId);
    }

    const overdue = this.isOverdue(row.interval_min, row.last_heartbeat_at);
    if (overdue) {
      try {
        await this.sos.raise(userId, {
          lat: args.lat,
          lng: args.lng,
          reason: 'vbg_biometric_missed',
          payload: {source: 'vbg_monitoring', missed_count: row.missed_count + 1},
        });
      } catch (e) {
        // Never let an escalation failure swallow the heartbeat write —
        // log and continue so the user's "I'm fine" tap still lands.
        this.log.error(`VBG escalation via SOS failed: ${(e as Error).message}`);
      }
    }

    const isFiniteLat = typeof args.lat === 'number' && Number.isFinite(args.lat);
    const isFiniteLng = typeof args.lng === 'number' && Number.isFinite(args.lng);
    await this.db.q(
      `UPDATE public.vbg_monitoring
          SET last_heartbeat_at = NOW(),
              missed_count      = 0,
              lat               = COALESCE($2, lat),
              lng               = COALESCE($3, lng)
        WHERE user_id = $1`,
      [userId, isFiniteLat ? args.lat : null, isFiniteLng ? args.lng : null],
    );
    return this.monitoringStatus(userId);
  }

  /**
   * BE-7.4 — biometric check-in. `pass` resets the consecutive-fail
   * counter; `fail` increments it. On the 3rd consecutive fail we escalate
   * (Ops WS event + Twilio SMS within 60s + SOS), then reset so the next
   * window starts clean. A back-compat alias for the old `heartbeat`.
   */
  async biometricCheckin(
    userId: string,
    args: {result: 'pass' | 'fail'; lat?: number; lng?: number},
  ): Promise<MonitoringStatusDto> {
    const row = await this.db.qOne<{status: string; consecutive_fails: number}>(
      'SELECT status, consecutive_fails FROM public.vbg_monitoring WHERE user_id = $1',
      [userId],
    );
    if (!row || row.status !== 'active') {return this.monitoringStatus(userId);}

    if (args.result === 'pass') {
      await this.db.q(
        'UPDATE public.vbg_monitoring SET last_heartbeat_at = NOW(), consecutive_fails = 0, missed_count = 0 WHERE user_id = $1',
        [userId],
      );
      return this.monitoringStatus(userId);
    }

    const fails = row.consecutive_fails + 1;
    await this.db.q(
      'UPDATE public.vbg_monitoring SET consecutive_fails = $2, missed_count = $2 WHERE user_id = $1',
      [userId, fails],
    );

    if (fails >= MISSED_WINDOWS_BEFORE_ESCALATION) {
      // SMS targets the Next-of-Kin favorites (fallback: the principal) — H-4.
      const phones = await this.escalationPhones(userId);
      // Fan out: Ops WS + SMS + SOS + Kafka. Best-effort; never throw.
      await Promise.allSettled([
        this.events.broadcast(`vbg:${userId}`, 'mission.status', {kind: 'vbg.biometric.escalation', fails}),
        this.audit.emitEscalation({type: 'biometric_missed', user_id: userId, detail: `${fails} consecutive failed scans`, lat: args.lat, lng: args.lng}),
        ...phones.map(p => this.sms.sendSms(p, `Bravo Secure: ${fails} missed biometric check-ins. Ops Room dispatched.`)),
        this.sos.raise(userId, {lat: args.lat, lng: args.lng, reason: 'vbg_biometric_missed', payload: {source: 'vbg_biometric', consecutive_fails: fails}}),
      ]);
      // Reset so we don't re-fire on every subsequent fail.
      await this.db.q('UPDATE public.vbg_monitoring SET consecutive_fails = 0 WHERE user_id = $1', [userId]);
    }
    return this.monitoringStatus(userId);
  }

  async monitoringStatus(userId: string): Promise<MonitoringStatusDto> {
    const row = await this.db.qOne<{
      status: string;
      interval_min: number;
      enrolled_at: Date;
      last_heartbeat_at: Date | null;
      missed_count: number;
    }>(
      `SELECT status, interval_min, enrolled_at, last_heartbeat_at, missed_count
         FROM public.vbg_monitoring
        WHERE user_id = $1`,
      [userId],
    );
    if (!row) {
      return {
        enrolled: false, status: null, interval_min: null, enrolled_at: null,
        last_heartbeat_at: null, missed_count: 0, overdue: false,
      };
    }
    return {
      enrolled: row.status === 'active',
      status: row.status,
      interval_min: row.interval_min,
      enrolled_at: row.enrolled_at.toISOString(),
      last_heartbeat_at: row.last_heartbeat_at?.toISOString() ?? null,
      missed_count: row.missed_count,
      overdue: this.isOverdue(row.interval_min, row.last_heartbeat_at),
    };
  }

  /** The principal's own phone — the default escalation SMS target. */
  async contactPhone(userId: string): Promise<string | null> {
    const row = await this.db.qOne<{phone_e164: string | null}>(
      'SELECT phone_e164 FROM public.users WHERE id = $1',
      [userId],
    );
    return row?.phone_e164 ?? null;
  }

  private isOverdue(intervalMin: number, lastBeat: Date | null): boolean {
    if (!lastBeat) {return false;}
    const windowMs = intervalMin * 60_000 * MISSED_WINDOWS_BEFORE_ESCALATION;
    return Date.now() - lastBeat.getTime() > windowMs;
  }

  /**
   * Live region threats for the OSINT feed. GPS → region (Mapbox) →
   * threats (GDELT), classified by severity. No persistence.
   *
   * B-91 M2 R6 (spec p.20) — the News Feed is a ROLLING LAST-72-HOURS
   * surface, enforced at the query/data layer: the window scopes the GDELT
   * timespan AND a strict post-blend cutoff (no fall-back-to-unfiltered, and
   * undated items are dropped — "no article older than 72 hours is returned"
   * can't be proven for them). Callers may pass a narrower window (GeoRisk's
   * 24/48h) but never a wider-than-default feed.
   */
  private static readonly NEWS_WINDOW_HOURS = 72;

  async regionThreats(args: {lat?: number; lng?: number; timeWindowHours?: number}): Promise<RegionThreatsDto> {
    const lat = num(args.lat);
    const lng = num(args.lng);
    // Reject a missing fix rather than silently reverse-geocoding (0,0) and
    // returning a plausible-but-meaningless "Null Island" feed. Clients that
    // have no GPS fix degrade to their no-location empty state on this error.
    if (lat === null || lng === null) {
      throw new BadRequestException('A location (lat/lng) is required for the threat feed.');
    }
    const windowHours = Math.min(
      num(args.timeWindowHours) ?? VbgService.NEWS_WINDOW_HOURS,
      VbgService.NEWS_WINDOW_HOURS,
    );
    const fix = await this.geocode.reverse(lat, lng);
    const blended = await this.threatsForArea(fix, windowHours);
    const threats = withinWindowStrict(blended, windowHours);
    return {region: fix.region, context: fix.context, country: fix.country ?? null, threats, counts: countBy(threats)};
  }

  /**
   * Live threats for an area, BLENDED from multiple free sources for real
   * global coverage:
   *   • GDELT — global event feed (free, commercial-OK, but thin on small
   *     / non-English-media places), with a widen-to-country fallback.
   *   • NewsData.io — 88k sources / 206 countries, scoped to the ISO country;
   *     surfaces local incidents GDELT misses (optional — only if a key is set).
   *   • Google News RSS — completely free, no key, no daily cap; the widest
   *     local coverage of any free source, scoped to the place names + the
   *     country edition. Fills the gaps the other two miss.
   * Results are merged + deduped by headline. Still 100% live data.
   */
  private async threatsForArea(
    fix: {region: string; context: string; country?: string | null},
    timeWindowHours?: number,
    radiusKm?: number,
  ): Promise<ThreatItem[]> {
    // Run every source in PARALLEL and time-bound the slow ones so a
    // rate-limited / 429-ing GDELT (free tier: 1 req / 5s, serialized) can't
    // stall the whole SRA past the client's 15s timeout. NewsData is fast +
    // reliable, so the assessment still returns even if GDELT is throttled.
    const broad = broadestAreaTerm(fix.context, fix.region);

    // RADIUS-AWARE place scope: a small radius means "right here" (just the
    // locality); a big radius widens to the surrounding district / city /
    // division so the news covers the whole circle. Place hierarchy comes
    // from the reverse-geocode context ("Siddirganj, Narayanganj, Dhaka,
    // Bangladesh"); we drop the last segment (country) since it's a filter.
    const placeTerms = placeTermsForRadius(fix.region, fix.context, radiusKm);

    // GDELT (specific + optional widen) — capped so it never dominates.
    const gdeltP = withTimeout(
      (async () => {
        const specific = await this.gdelt.threatsForRegion(fix.region, timeWindowHours);
        if (specific.length > 0) {return specific;}
        if (broad && broad.toLowerCase() !== fix.region.trim().toLowerCase()) {
          return this.gdelt.threatsForRegion(broad, timeWindowHours);
        }
        return specific;
      })(),
      GDELT_BUDGET_MS,
      [] as ThreatItem[],
    );

    // NewsData — scoped to the PLACE NAMES (about the area), not just the
    // publisher country, so we don't surface a BD paper's Lebanon/Ukraine
    // coverage. Radius controls how many surrounding places are included.
    const newsP = withTimeout(
      this.newsdata.threatsForArea(placeTerms, fix.country ?? null),
      NEWS_BUDGET_MS,
      [] as ThreatItem[],
    );

    // Google News RSS — same place-scoped query, free + uncapped, country
    // edition for local relevance. Widest local coverage of the three.
    const gnewsP = withTimeout(
      this.googlenews.threatsForArea(placeTerms, fix.country ?? null),
      NEWS_BUDGET_MS,
      [] as ThreatItem[],
    );

    // Curated OSINT outlets — the same place+threat query restricted to the
    // founder's per-country outlet directory. Local papers report incidents
    // the open index ranks out; skipped for countries the directory doesn't
    // cover yet.
    const curatedDomains = osintDomainsFor(fix.country ?? null);
    const curatedP = curatedDomains.length
      ? withTimeout(
          this.googlenews.threatsForArea(placeTerms, fix.country ?? null, curatedDomains),
          NEWS_BUDGET_MS,
          [] as ThreatItem[],
        )
      : Promise.resolve([] as ThreatItem[]);

    const [gdelt, news, gnews, curated] = await Promise.all([gdeltP, newsP, gnewsP, curatedP]);
    const blended = dedupeThreats([...gdelt, ...news, ...gnews, ...curated]);
    // Founder relevance rule 2026-08-01 — local outlets cover world news, so
    // the place-scoped queries alone let "Thirteen killed in Japan earthquake"
    // (via a UAE paper) into an Abu Dhabi assessment. Drop any headline whose
    // only country references are foreign; home-country or place-term mentions
    // always keep it, and headlines with no country claim pass untouched.
    return blended.filter(t => isLocallyRelevant(t.title, fix.country, [fix.region, ...placeTerms]));
  }

  /**
   * Region-aware SRA snapshot. The risk score is computed from the volume
   * and severity of LIVE regional threats (GDELT) for the reverse-geocoded
   * place — not a hardcoded baseline. Persisted so ops has a record of what
   * the principal was shown.
   */
  async sraSnapshot(
    userId: string,
    args: {lat?: number; lng?: number; radiusKm?: number; timeWindowHours?: number},
  ): Promise<SraSnapshotDto> {
    const lat = num(args.lat);
    const lng = num(args.lng);
    const radiusKm = num(args.radiusKm);
    const timeWindowHours = num(args.timeWindowHours);
    // Reject a missing fix rather than scoring + persisting a meaningless
    // (0,0) "Null Island" snapshot. Clients with no GPS fix degrade to their
    // "assessment unavailable" empty state on this error.
    if (lat === null || lng === null) {
      throw new BadRequestException('A location (lat/lng) is required for the security assessment.');
    }
    const fix = await this.geocode.reverse(lat, lng);
    const blended = await this.threatsForArea(fix, timeWindowHours ?? undefined, radiusKm ?? undefined);
    // Apply the time window OURSELVES (NewsData's `timeframe` param is a paid
    // feature; GDELT's timespan only bounds GDELT). Keep items within the
    // window; if that empties the list, keep the unfiltered set so the screen
    // still shows the latest available rather than going blank.
    const threats = withinWindow(blended, timeWindowHours);
    const counts = countBy(threats);

    // Score: each critical weighs 8, each caution 3, capped at 100. A
    // region with no live incidents reads LOW rather than a fake baseline.
    // Why (audit M-8, known bias): the score tracks REPORTED incident volume,
    // so media-dense English-language metros trend higher than genuinely
    // riskier low-coverage areas (sources are English-scoped). Treat it as a
    // news-activity indicator, not an absolute danger ranking.
    const riskScore = Math.min(100, counts.critical * 8 + counts.caution * 3);
    const level: SraSnapshotDto['level'] = riskScore >= 75 ? 'CRITICAL'
      : riskScore >= 50 ? 'HIGH' : riskScore >= 25 ? 'MEDIUM' : 'LOW';

    const lvl = (n: number, hi: number, mid: number): 'low' | 'medium' | 'high' =>
      n >= hi ? 'high' : n >= mid ? 'medium' : 'low';
    // Only GENUINE threats back the categories. The place+threat query can
    // still match a town name inside a non-threat headline (e.g. a cricket
    // result mentioning a Punjab town), which classifies as theme 'advisory'
    // / severity 'information' — exclude those so a cricket win never shows
    // as "crime". Each category is matched by its own theme keywords.
    const toArticle = (t: ThreatItem): RiskArticle => ({
      title: t.title, url: t.url, source: t.source, seenAt: t.seenAt, severity: t.severity,
    });
    const realThreats = threats.filter(t => t.theme !== 'advisory' && t.severity !== 'information');
    const matchArticles = (re: RegExp): RiskArticle[] =>
      realThreats.filter(t => re.test(`${t.theme} ${t.title}`.toLowerCase())).slice(0, 8).map(toArticle);

    // Word-START boundaries (same rule as threatClassify.hasWord): bare
    // substrings put "killer cholesterol" and "skills" into Violent Crime.
    const violent = matchArticles(/\b(shoot|murder|kill|stab|hijack|kidnap|terror|bomb|blast|assault|gun|armed)/);
    const robbery = matchArticles(/\b(robber|mugg|theft|burglar|carjack|loot)/);
    const civil   = matchArticles(/\b(protest|riot|unrest|demonstration|clash|curfew|vandal)/);
    // Opportunistic = the remaining REAL threats not already in another bucket.
    const bucketed = new Set([...violent, ...robbery, ...civil].map(a => a.url));
    const opportunistic = realThreats.filter(t => !bucketed.has(t.url)).slice(0, 8).map(toArticle);

    const risks: SraSnapshotDto['risks'] = [
      {name: 'Violent Crime',       level: lvl(violent.length, 3, 1), articles: violent},
      {name: 'Robbery / Theft',     level: lvl(robbery.length, 4, 1), articles: robbery},
      {name: 'Civil Disruption',    level: lvl(civil.length, 2, 1),   articles: civil},
      {name: 'Opportunistic Crime', level: lvl(opportunistic.length, 6, 2), articles: opportunistic},
    ];

    // Window/scope phrases reflect the GeoRisk controls when supplied.
    const scope = radiusKm ? `within ${radiusKm} km of ${fix.region}` : `in ${fix.region}`;
    const window = windowPhrase(timeWindowHours);
    // Founder spec 2026-08-01 — full 75–100-word executive summary (threat
    // environment, incident patterns, escalation trend); the client renders
    // it untruncated.
    const summary = buildExecutiveSummary({
      scope,
      window,
      counts,
      level,
      risks,
      trend: escalationTrend(threats, timeWindowHours),
    });

    const snapshot: Omit<SraSnapshotDto, 'created_at'> = {
      region: fix.region,
      context: fix.context,
      risk_score: riskScore,
      level,
      summary,
      risks,
      recommendations: buildRecommendations(level, risks),
      counts,
      lat: lat ?? null,
      lng: lng ?? null,
    };

    // Persist the FULL assessment the principal saw (audit M-10) so ops can
    // answer "what was the user told?" from the record alone.
    const row = await this.db.qOne<{created_at: Date}>(
      `INSERT INTO public.vbg_sra_snapshots
         (user_id, lat, lng, risk_score, risks, recommendations, region, context, level, summary, counts)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11::jsonb)
       RETURNING created_at`,
      [
        userId, snapshot.lat, snapshot.lng, snapshot.risk_score,
        JSON.stringify(snapshot.risks), JSON.stringify(snapshot.recommendations),
        snapshot.region, snapshot.context, snapshot.level, snapshot.summary,
        JSON.stringify(snapshot.counts),
      ],
    );
    return {...snapshot, created_at: (row?.created_at ?? new Date()).toISOString()};
  }

  /**
   * Real nearby key points — police / hospital / embassy / fire, with their
   * true coordinates and great-circle distance from the caller's fix.
   *
   * Primary source is OpenStreetMap Overpass (free, no key, WORLDWIDE, true
   * `around:radius` search) — Mapbox's POI geocoder has poor coverage outside
   * major Western cities (it returns nothing for many regions, e.g. parts of
   * South Asia). Mapbox is kept as a fallback for when Overpass is down/empty.
   *
   * `radiusKm` is the search ring (default ~20 km; GeoRisk passes 5/50/200).
   */
  async keyPoints(args: {lat?: number; lng?: number; radiusKm?: number}): Promise<KeyPoint[]> {
    const lat = num(args.lat);
    const lng = num(args.lng);
    if (lat === null || lng === null) {return [];}
    const radiusKm = num(args.radiusKm) ?? DEFAULT_KEYPOINT_RADIUS_KM;

    // 1) Overpass (OSM) — primary, real radius, global.
    const osm = await this.keyPointsOverpass(lat, lng, radiusKm);
    if (osm.length > 0) {return osm.slice(0, 8);}

    // 2) Mapbox — fallback only.
    return this.keyPointsMapbox(lat, lng, radiusKm);
  }

  /**
   * OpenStreetMap Overpass POI lookup. Maps OSM tags → our 4 kinds with a
   * single `around:` query, distance-sorts, returns the nearest. Free, no key.
   */
  private async keyPointsOverpass(lat: number, lng: number, radiusKm: number): Promise<KeyPoint[]> {
    const r = Math.round(Math.min(Math.max(radiusKm, 1), 500) * 1000); // metres, clamped
    // amenity=police|hospital|clinic|fire_station, office=diplomatic (embassy).
    // `nwr` (node|way|relation) + `out center` — most large hospitals / police
    // compounds are mapped as ways/relations, which a node-only query misses
    // entirely (audit M-1). `center` supplies the centroid for non-nodes.
    const query =
      '[out:json][timeout:25];(' +
      `nwr["amenity"="police"](around:${r},${lat},${lng});` +
      `nwr["amenity"="hospital"](around:${r},${lat},${lng});` +
      `nwr["amenity"="clinic"](around:${r},${lat},${lng});` +
      `nwr["amenity"="fire_station"](around:${r},${lat},${lng});` +
      `nwr["office"="diplomatic"](around:${r},${lat},${lng});` +
      `nwr["diplomatic"](around:${r},${lat},${lng});` +
      ');out center 60;';
    const endpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ];
    for (const ep of endpoints) {
      try {
        // Hard time-bound each Overpass endpoint so a slow mirror can't hang
        // the keypoints request past the client timeout.
        const res = await fetch(ep, {
          method: 'POST',
          headers: {'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'BravoSecure/1.0 (+vbg)'},
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(OVERPASS_BUDGET_MS),
        });
        if (!res.ok) {continue;}
        const body = await res.json() as {elements?: Array<{lat?: number; lon?: number; center?: {lat?: number; lon?: number}; tags?: Record<string, string>}>};
        const out: KeyPoint[] = [];
        for (const el of body.elements ?? []) {
          // Nodes carry lat/lon directly; ways/relations carry a `center`.
          const elLat = Number.isFinite(el.lat) ? el.lat : el.center?.lat;
          const elLng = Number.isFinite(el.lon) ? el.lon : el.center?.lon;
          if (!Number.isFinite(elLat) || !Number.isFinite(elLng)) {continue;}
          const kind = osmKind(el.tags ?? {});
          if (!kind) {continue;}
          const label = el.tags?.name ?? el.tags?.['name:en'] ?? KEYPOINT_LABEL[kind];
          out.push({kind, label, lat: elLat as number, lng: elLng as number, distanceKm: haversineKm(lat, lng, elLat as number, elLng as number)});
        }
        if (out.length > 0) {return out.sort((a, b) => a.distanceKm - b.distanceKm);}
      } catch (e) {
        this.log.warn(`overpass keypoint lookup failed (${ep}): ${(e as Error).message}`);
      }
    }
    return [];
  }

  /** Mapbox POI fallback (text-relevance geocoder; radius treated as a soft preference). */
  private async keyPointsMapbox(lat: number, lng: number, radiusKm: number): Promise<KeyPoint[]> {
    if (!this.mapboxToken) {return [];}
    const out: KeyPoint[] = [];
    // Audit Rev2 API-05 — ONE shared budget across the sequential per-query
    // Mapbox calls, so this loop can't sum into a ~20s stall (4 queries × the
    // old unbounded fetch). Each call still carries its own 5s deadline; the
    // budget caps the total. Combined with the caller's Overpass budget this
    // bounds keyPoints() overall instead of N×5s.
    const budget = AbortSignal.timeout(12_000);
    for (const {kind, q} of KEYPOINT_QUERIES) {
      try {
        const url =
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
          `?proximity=${lng},${lat}&types=poi&limit=3&access_token=${this.mapboxToken}`;
        const res = await fetchWithDeadline(url, {method: 'GET', deadlineMs: 5_000, signal: budget});
        if (!res.ok) {continue;}
        const body = await res.json() as {features?: Array<{text?: string; center?: [number, number]}>};
        for (const f of body.features ?? []) {
          if (!f.center) {continue;}
          const [flng, flat] = f.center;
          out.push({kind, label: f.text ?? q, lat: flat, lng: flng, distanceKm: haversineKm(lat, lng, flat, flng)});
        }
      } catch (e) {
        this.log.warn(`keypoint lookup (${kind}) failed: ${(e as Error).message}`);
      }
    }
    const sorted = out.sort((a, b) => a.distanceKm - b.distanceKm);
    const inRing = sorted.filter(p => p.distanceKm <= radiusKm);
    return (inRing.length > 0 ? inRing : sorted).slice(0, 6);
  }

  // ── BE-7.6 — Next-of-Kin favorites (server-backed, reinstall-durable) ─────
  async listFavorites(userId: string): Promise<FavoriteDtoOut[]> {
    const rows = await this.db.q<{id: string; name: string; phone: string; position: number}>(
      `SELECT id, name, phone, position
         FROM public.vbg_favorites
        WHERE user_id = $1
        ORDER BY position ASC, created_at ASC`,
      [userId],
    );
    return rows.map(r => ({id: r.id, name: r.name, phone: r.phone, position: r.position}));
  }

  /**
   * Replace-the-set: the client sends the full 0..3 list and we reconcile
   * to it. Keyed on the normalized E.164 so re-saving the same number keeps
   * its row (stable id) and just refreshes name/position. Returns the
   * persisted list so the client renders exactly what's stored.
   */
  async setFavorites(
    userId: string,
    favorites: Array<{name: string; phone: string}>,
  ): Promise<FavoriteDtoOut[]> {
    // A client-sent empty array is an intentional "clear all". Capture that
    // BEFORE normalization so it can't be conflated with the all-invalid case.
    const isIntentionalClear = favorites.length === 0;

    // Normalize + dedupe by E.164 (last write wins), cap at 3.
    const seen = new Map<string, {name: string; phone: string; e164: string}>();
    for (const f of favorites) {
      const e164 = normalizePhone(f.phone);
      if (!e164) {continue;}
      seen.set(e164, {name: f.name.trim().slice(0, 60), phone: f.phone.trim().slice(0, 32), e164});
    }
    const final = Array.from(seen.values()).slice(0, 3);
    const keepKeys = final.map(f => f.e164);

    // Guard the data-loss footgun: the client sent contacts but NONE produced
    // a valid phone. Treating that as a clear would silently wipe the user's
    // existing emergency contacts. Reject it as bad input instead — only a
    // truly empty submission clears the set.
    if (!isIntentionalClear && keepKeys.length === 0) {
      throw new BadRequestException('No valid phone numbers in the submitted favorites.');
    }

    await this.db.withTransaction(async tx => {
      // Serialize concurrent saves for the SAME user so two overlapping
      // DELETE/upsert reconciles can't deadlock on opposite lock orders
      // (40P01). Transaction-scoped — released on COMMIT/ROLLBACK.
      await tx.q('SELECT pg_advisory_xact_lock(hashtext($1))', [`vbg_favorites:${userId}`]);

      // Drop favorites the client no longer lists.
      if (keepKeys.length === 0) {
        await tx.q('DELETE FROM public.vbg_favorites WHERE user_id = $1', [userId]);
      } else {
        await tx.q(
          `DELETE FROM public.vbg_favorites
            WHERE user_id = $1 AND phone_e164 <> ALL($2::text[])`,
          [userId, keepKeys],
        );
      }
      // Upsert each kept favorite at its new slot.
      for (let i = 0; i < final.length; i++) {
        const f = final[i];
        await tx.q(
          `INSERT INTO public.vbg_favorites (user_id, name, phone, phone_e164, position)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, phone_e164) DO UPDATE
             SET name = EXCLUDED.name, phone = EXCLUDED.phone, position = EXCLUDED.position`,
          [userId, f.name, f.phone, f.e164, i],
        );
      }
    });

    return this.listFavorites(userId);
  }
}

// Default "nearby safe havens" ring for the Key Points screen.
const DEFAULT_KEYPOINT_RADIUS_KM = 20;

// Per-source time budgets so a slow/throttled upstream can't blow past the
// client's 15s axios timeout. GDELT is the slow one (5s spacing + 429s);
// NewsData is fast. The SRA returns whatever resolved within budget.
const GDELT_BUDGET_MS = 7_000;
const NEWS_BUDGET_MS  = 6_000;
const OVERPASS_BUDGET_MS = 8_000;

/** Resolve `p` within `ms`, else fall back to `onTimeout` (never rejects). */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(onTimeout); } }, ms);
    p.then(v => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } })
     .catch(() => { if (!settled) { settled = true; clearTimeout(t); resolve(onTimeout); } });
  });
}

/**
 * Coarse E.164 normalization for the favorites uniqueness key — strips
 * formatting, keeps a single leading '+', and rejects implausible lengths.
 * The display `phone` keeps whatever the user typed; this is only the key.
 */
function normalizePhone(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {return null;}
  const withPlus = trimmed.replace(/^00/, '+');
  const hasPlus = withPlus.startsWith('+');
  const digits = withPlus.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) {return null;}
  return hasPlus ? `+${digits}` : digits;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** GCM AAD binding a telemetry blob to its owner (audit M-5). */
export function telemetryAad(userId: string): string {
  return `vbg1:${userId}`;
}

/**
 * Clamp a client-supplied recordedAt to a sane window around server time —
 * clock drift and replayed blobs otherwise write arbitrary timestamps into
 * the track (audit M-5). Accepts [now-10min, now+2min]; otherwise now.
 */
function clampRecordedAt(recordedAt?: string): string {
  const now = Date.now();
  if (recordedAt) {
    const ms = Date.parse(recordedAt);
    if (!Number.isNaN(ms) && ms >= now - 10 * 60_000 && ms <= now + 2 * 60_000) {
      return new Date(ms).toISOString();
    }
  }
  return new Date(now).toISOString();
}

/**
 * Build situation-specific recommendations from the live risk picture — the
 * overall level plus which categories are elevated — instead of a fixed list.
 * A violent-crime hotspot gets personal-security advice; a protest-heavy area
 * gets "avoid demonstrations"; a calm area gets routine awareness. Always
 * returns 3-5 prioritised, de-duplicated items.
 */
function buildRecommendations(
  level: SraSnapshotDto['level'],
  risks: SraSnapshotDto['risks'],
): string[] {
  const lvlOf = (name: string) => risks.find(r => r.name === name)?.level ?? 'low';
  const violent = lvlOf('Violent Crime');
  const robbery = lvlOf('Robbery / Theft');
  const civil   = lvlOf('Civil Disruption');
  const recs: string[] = [];

  // Headline guidance by overall level.
  if (level === 'CRITICAL') {
    recs.push('Avoid non-essential travel in this area; defer movement until the situation eases.');
    recs.push('Keep your Ops Room contact and panic button immediately accessible.');
  } else if (level === 'HIGH') {
    recs.push('Limit time in public and avoid reported hotspots; plan routes in advance.');
  } else if (level === 'MEDIUM') {
    recs.push('Maintain heightened situational awareness when moving through the area.');
  } else {
    recs.push('Maintain routine awareness; no elevated precautions required right now.');
  }

  // Category-specific advice (only when that risk is actually elevated).
  if (violent === 'high') {
    recs.push('Vary your routes and timings; avoid travelling alone after dark.');
    recs.push('Stay clear of crowds and any reported incident scenes.');
  } else if (violent === 'medium') {
    recs.push('Stay alert in unfamiliar areas and keep to well-lit, populated routes.');
  }
  if (robbery === 'high' || robbery === 'medium') {
    recs.push('Keep valuables, phones and cash out of sight in public.');
  }
  if (civil === 'high' || civil === 'medium') {
    recs.push('Avoid protests, demonstrations and large gatherings; they can escalate quickly.');
  }

  // Baseline fallbacks so the list always has substance.
  if (recs.length < 3) {recs.push('Stay alert and aware of your surroundings.');}
  if (recs.length < 3) {recs.push('Share your live location with a trusted contact.');}

  // Dedupe + cap at 5.
  return Array.from(new Set(recs)).slice(0, 5);
}

/**
 * Keep threats whose `seenAt` falls within the time window. Done on our side
 * because NewsData's `timeframe` filter is a paid feature. Degrades to the
 * full set if the window would empty the list (so the screen isn't blank).
 */
function withinWindow(items: ThreatItem[], timeWindowHours?: number | null): ThreatItem[] {
  if (!timeWindowHours || !Number.isFinite(timeWindowHours) || timeWindowHours <= 0) {return items;}
  const cutoff = Date.now() - timeWindowHours * 3_600_000;
  const inWindow = items.filter(t => {
    const ms = Date.parse(t.seenAt);
    return Number.isNaN(ms) || ms >= cutoff;   // keep undated items
  });
  return inWindow.length > 0 ? inWindow : items;
}

/**
 * B-91 M2 R6 — STRICT rolling-window filter for the News Feed surface:
 * drops undated items and never falls back to the unfiltered set (an empty
 * feed is the correct answer for a quiet 72 hours; the SRA path keeps the
 * lenient `withinWindow` above so an assessment always has material).
 */
function withinWindowStrict(items: ThreatItem[], timeWindowHours: number): ThreatItem[] {
  const cutoff = Date.now() - timeWindowHours * 3_600_000;
  return items.filter(t => {
    const ms = Date.parse(t.seenAt);
    return !Number.isNaN(ms) && ms >= cutoff;
  });
}

/** Merge threat items from multiple sources, deduped by headline prefix. */
function dedupeThreats(items: ThreatItem[]): ThreatItem[] {
  const seen = new Set<string>();
  const out: ThreatItem[] = [];
  for (const it of items) {
    if (!it.title || !it.url) {continue;}
    const k = it.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
    if (seen.has(k)) {continue;}
    seen.add(k);
    out.push(it);
  }
  // Surface the most severe first, newest within a severity.
  const rank = {critical: 0, caution: 1, information: 2} as const;
  return out.sort((a, b) =>
    rank[a.severity] - rank[b.severity] || (b.seenAt.localeCompare(a.seenAt)));
}

/**
 * Build the radius-aware list of place names to search local news for.
 *
 * Context is a hierarchy like "Siddirganj, Narayanganj, Dhaka, Bangladesh".
 * We drop the last segment (country — it's a separate filter) and include
 * MORE of the surrounding hierarchy as the radius grows, so 5 km stays on the
 * locality while 200 km pulls in the district / city / division:
 *   • ≤ 10 km  → region only (the immediate locality)
 *   • ≤ 50 km  → region + next 1 level (district)
 *   • > 50 km  → region + next 2 levels (district + city/division)
 */
function placeTermsForRadius(region: string, context: string, radiusKm?: number): string[] {
  // Keep only Latin-script place names — NewsData's query parser errors on
  // non-Latin script (e.g. Bengali district names), which would drop ALL
  // local news. Mapbox supplies a Latin name alongside the local-script one.
  // Also strip hyper-granular admin suffixes (Thana / District / Barangay N /
  // Ward N) that news never mentions and that just bloat the query.
  const isLatin = (s: string) => /[a-z]/i.test(s) && !/[^ -ɏ]/.test(s);
  const clean = (s: string) =>
    s.replace(/\b(thana|district|division|sub-?district|barangay\s*\d*|ward\s*\d*)\b/gi, '')
     .replace(/\s{2,}/g, ' ').replace(/[,\s]+$/, '').trim();
  const usable = (s: string) => !!s && isLatin(s) && s.length >= 3;

  const parts = (context ?? '').split(',').map(clean).filter(usable);
  const hierarchy = parts.length > 1 ? parts.slice(0, -1) : parts; // drop country
  // Total place terms by radius. A hyper-local name alone (a thana / barangay)
  // returns no news, so even the SMALLEST radius includes the parent city —
  // bigger radii add the surrounding district / division on top.
  //   ≤10km → 2 (locality + city) · ≤50km → 3 · >50km → 4.
  const r = radiusKm ?? 20;
  const maxTerms = r <= 10 ? 2 : r <= 50 ? 3 : 4;
  const candidates = [clean(region), ...hierarchy].filter(usable);

  // Cap COUNT (by radius) and TOTAL query length so the NewsData query stays
  // under its 100-char limit — exceeding it errors and returns nothing (the
  // cause of "200km returns nothing" for places with long admin hierarchies).
  const seen = new Set<string>();
  const out: string[] = [];
  let budget = 56; // reserve room for the threat-term clause + quoting
  for (const v of candidates) {
    if (out.length >= maxTerms) {break;}
    const k = v.toLowerCase();
    if (seen.has(k) || v.length + 7 > budget) {continue;}
    seen.add(k);
    out.push(v);
    budget -= v.length + 7;
  }
  return out;
}

/**
 * Pull the broadest area term from a reverse-geocode context for a wider
 * threat query. Context looks like "Narayanganj, Dhaka, Bangladesh" — the
 * last comma-segment is the country, the best fallback search term.
 */
function broadestAreaTerm(context: string, region: string): string | null {
  const parts = (context ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) {return region || null;}
  return parts[parts.length - 1];
}

/** Human lookback phrase for the SRA summary, from the GeoRisk time window. */
function windowPhrase(hours?: number | null): string {
  if (!hours || !Number.isFinite(hours) || hours <= 0) {return 'in the last 3 weeks';}
  if (hours <= 48) {return `in the last ${Math.round(hours)} hours`;}
  const days = Math.round(hours / 24);
  return `in the last ${days} day${days === 1 ? '' : 's'}`;
}

export type EscalationTrend = 'increasing' | 'decreasing' | 'stable';

/**
 * Escalation direction across the selected window: severity-weighted signal
 * volume in the newer half vs the older half (critical 8 / caution 3 /
 * information 1 — the risk score's own weights). Undated items cannot be
 * placed and are skipped; a quiet or unplaceable window reads 'stable'. The
 * ±25%/−20% dead band keeps one stray headline from flipping the assessment.
 */
export function escalationTrend(threats: ThreatItem[], timeWindowHours?: number | null): EscalationTrend {
  const hours = !timeWindowHours || !Number.isFinite(timeWindowHours) || timeWindowHours <= 0
    ? 21 * 24   // mirrors windowPhrase's 3-week default
    : timeWindowHours;
  const now = Date.now();
  const start = now - hours * 3_600_000;
  const mid = now - (hours / 2) * 3_600_000;
  const weightOf = (t: ThreatItem): number =>
    t.severity === 'critical' ? 8 : t.severity === 'caution' ? 3 : 1;
  let earlier = 0;
  let recent = 0;
  for (const t of threats) {
    const ms = Date.parse(t.seenAt);
    if (Number.isNaN(ms) || ms < start) {continue;}
    if (ms >= mid) {recent += weightOf(t);} else {earlier += weightOf(t);}
  }
  if (earlier === 0 && recent === 0) {return 'stable';}
  if (earlier === 0) {return 'increasing';}
  if (recent === 0) {return 'decreasing';}
  const ratio = recent / earlier;
  return ratio >= 1.25 ? 'increasing' : ratio <= 0.8 ? 'decreasing' : 'stable';
}

/**
 * Founder spec 2026-08-01 — the Executive Summary is a ~75–100-word
 * assessment shown IN FULL on the client: the threat environment for the
 * selected radius, incident volume and dominant patterns from the OSINT
 * feeds in the selected window, the escalation trend, and a posture line.
 * Every branch must stay inside the word band (pinned by a spec test).
 */
export function buildExecutiveSummary(args: {
  scope:  string;
  window: string;
  counts: {critical: number; caution: number; information: number};
  level:  SraSnapshotDto['level'];
  risks:  SraSnapshotDto['risks'];
  trend:  EscalationTrend;
}): string {
  const {scope, window, counts, level, risks, trend} = args;
  const total = counts.critical + counts.caution;

  const levelWord = level === 'CRITICAL' ? 'critical'
    : level === 'HIGH' ? 'elevated' : level === 'MEDIUM' ? 'moderate' : 'low';
  const environment = `The current threat environment ${scope} is assessed as ${levelWord}.`;

  const volume = total > 0
    ? `Open-source news and intelligence monitoring ${window} surfaced ${counts.critical} serious and ${counts.caution} cautionary incident ${total === 1 ? 'signal' : 'signals'} across the monitored area.`
    : `Open-source news and intelligence monitoring ${window} surfaced no significant incident signals across the monitored area, and nearby feeds remain quiet.`;

  const active = risks
    .filter(r => r.level !== 'low' && r.articles.length > 0)
    .sort((a, b) => b.articles.length - a.articles.length);
  const catName = (name: string): string => name.toLowerCase().replace(' / ', ' and ');
  let pattern: string;
  if (active.length > 0) {
    const [first, second] = active;
    pattern = second
      ? `Reporting is concentrated in ${catName(first.name)} (${first.articles.length} ${first.articles.length === 1 ? 'report' : 'reports'}) and ${catName(second.name)} (${second.articles.length}), shaping the local risk pattern.`
      : `Reporting is concentrated in ${catName(first.name)} (${first.articles.length} ${first.articles.length === 1 ? 'report' : 'reports'}), which currently shapes the local risk pattern.`;
  } else if (total > 0) {
    pattern = 'No single risk pattern dominates; the reported incidents are scattered across categories at comparatively low intensity.';
  } else {
    pattern = 'No violent-crime, robbery, or civil-disruption patterns are currently visible in the monitored feeds for this area.';
  }

  const trendWord = trend === 'increasing' ? 'rising' : trend === 'decreasing' ? 'falling' : 'steady';
  const escalation = `Signal volume across the window is ${trendWord}, so the likelihood of escalation is assessed as ${trend === 'stable' ? 'remaining stable' : trend}.`;

  const posture = level === 'CRITICAL' || level === 'HIGH'
    ? 'Avoid identified hotspots, plan essential movement deliberately, and maintain heightened situational awareness while this picture holds.'
    : level === 'MEDIUM'
      ? 'Maintain normal situational awareness, and reassess local conditions before moving through the localities named in the reports.'
      : 'Routine awareness remains sufficient at this time, and no additional protective measures are indicated for movement in this area.';

  return `${environment} ${volume} ${pattern} ${escalation} ${posture}`;
}

function countBy(threats: ThreatItem[]): {critical: number; caution: number; information: number} {
  return {
    critical:    threats.filter(t => t.severity === 'critical').length,
    caution:     threats.filter(t => t.severity === 'caution').length,
    information: threats.filter(t => t.severity === 'information').length,
  };
}
