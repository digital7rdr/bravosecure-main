import {
  Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentUser}  from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {DatabaseService} from '../database/database.service';
import {TelemetryService, type TelemetryFix} from './telemetry.service';
import {TelemetryPingDto} from './dto/telemetry.dto';

/**
 * Telemetry surface:
 *   POST /telemetry/:bookingId/ping        (assigned CPO agent writes a fix)
 *   GET  /telemetry/:bookingId/latest      (client polls latest fix)
 *   GET  /telemetry/:bookingId/recent      (client reads a short trail)
 *
 * Auth model: client reads require ownership of the booking. Writes require
 * the caller to be the CPO currently assigned to the booking (checked against
 * `booking_cpo_assignments`). We gate writes to real assignees rather than
 * a generic "agent" role because it protects against a malicious client
 * spoofing fixes for a mission they don't belong to.
 */
// Audit Rev2 API-01 — bind UserThrottlerGuard so this SAFETY-CRITICAL live-
// mission GPS feed is rate-limited PER USER, not per IP. Without it the global
// IP-keyed guard would collapse a CGNAT full of co-located clients (or the ops
// console watching several missions from one browser) into one bucket and 429
// the tracker mid-mission. JwtAuthGuard runs first so req.user is populated
// when UserThrottlerGuard.getTracker keys on it; the global guard then skips
// this controller (it binds a ThrottlerGuard subclass).
@Controller('telemetry')
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class TelemetryController {
  constructor(
    private readonly telemetry: TelemetryService,
    private readonly db: DatabaseService,
  ) {}

  @Post(':bookingId/ping')
  async ping(
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: AccessClaims,
    @Body() dto: TelemetryPingDto,
  ): Promise<TelemetryFix> {
    await this.assertAgentCanWrite(bookingId, user.sub);
    return this.telemetry.ping(bookingId, {
      lat: dto.lat,
      lng: dto.lng,
      heading_deg: dto.heading_deg,
      speed_kph: dto.speed_kph,
      eta_minutes: dto.eta_minutes,
      source: dto.source,
    });
  }

  /**
   * Client-side companion to /ping — the booking client's app pushes its
   * own foreground GPS while the mission is active so ops can see the
   * principal's marker in addition to the CPO Lead's. Writes to the
   * mission row's client_lat/lng/recorded_at so the two feeds don't race.
   */
  @Post(':bookingId/client-ping')
  async clientPing(
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: AccessClaims,
    @Body() dto: {lat: number; lng: number},
  ): Promise<{ok: true}> {
    await this.assertBookingOwner(bookingId, user.sub);
    // B-89 MG-12 — typeof alone accepted NaN/Infinity/out-of-range and the
    // (0,0) "null island" default, teleporting the principal marker into
    // the Atlantic on every consumer map.
    const latOk = typeof dto?.lat === 'number' && Number.isFinite(dto.lat) && Math.abs(dto.lat) <= 90;
    const lngOk = typeof dto?.lng === 'number' && Number.isFinite(dto.lng) && Math.abs(dto.lng) <= 180;
    if (!latOk || !lngOk || (dto.lat === 0 && dto.lng === 0)) {
      throw new ForbiddenException('bad_fix');
    }
    await this.db.q(
      `UPDATE missions
          SET client_lat = $2, client_lng = $3, client_recorded_at = NOW()
        WHERE booking_id = $1
          AND status NOT IN ('COMPLETED','ABORTED')`,
      [bookingId, dto.lat, dto.lng],
    );
    return {ok: true};
  }

  @Get(':bookingId/latest')
  async latest(
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: AccessClaims,
  ): Promise<{latest: TelemetryFix | null}> {
    await this.assertClientCanRead(bookingId, user.sub);
    const latest = await this.telemetry.latest(bookingId);
    return {latest};
  }

  @Get(':bookingId/recent')
  async recent(
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: AccessClaims,
    @Query('count') count?: string,
  ): Promise<{fixes: TelemetryFix[]}> {
    await this.assertClientCanRead(bookingId, user.sub);
    const n = Math.min(Math.max(Number(count) || 60, 1), 200);
    const fixes = await this.telemetry.recent(bookingId, n);
    return {fixes};
  }

  // ── authorisation ────────────────────────────────────────────────────

  private async assertClientCanRead(bookingId: string, userId: string): Promise<void> {
    // Either the booking owner OR one of the assigned CPOs can read.
    // Why: $2 is compared as text in the CPO EXISTS subquery (`c.id::text = $2`),
    // so it must NOT also be pinned to uuid via `$2::uuid` here — Postgres resolves
    // a single type per parameter, and the `::uuid` pin turned the text comparison
    // into `text = uuid` (operator does not exist → 500). Compare client_id as text.
    const row = await this.db.qOne<{owner: boolean; is_cpo: boolean}>(
      `SELECT
         (b.client_id::text = $2)                                        AS owner,
         EXISTS (
           SELECT 1 FROM booking_cpo_assignments a
            JOIN cpo_pool c ON c.id = a.cpo_id
           WHERE a.booking_id = $1 AND c.id::text = $2
         )                                                               AS is_cpo
       FROM lite_bookings b
      WHERE b.id = $1`,
      [bookingId, userId],
    );
    if (!row || (!row.owner && !row.is_cpo)) {
      throw new ForbiddenException('booking_not_accessible');
    }
  }

  private async assertBookingOwner(bookingId: string, userId: string): Promise<void> {
    const row = await this.db.qOne<{ok: boolean}>(
      `SELECT (b.client_id = $2::uuid) AS ok FROM lite_bookings b WHERE b.id = $1`,
      [bookingId, userId],
    );
    if (!row?.ok) throw new ForbiddenException('not_booking_owner');
  }

  private async assertAgentCanWrite(bookingId: string, userId: string): Promise<void> {
    // Phase 1: any assigned CPO can write. Phase 2 will use the vehicle-driver
    // claim from the dispatch JWT instead of the user id → cpo mapping.
    const row = await this.db.qOne<{ok: boolean}>(
      `SELECT EXISTS (
         SELECT 1 FROM booking_cpo_assignments a
          WHERE a.booking_id = $1 AND a.cpo_id::text = $2
       ) AS ok`,
      [bookingId, userId],
    );
    if (!row?.ok) throw new ForbiddenException('not_assigned_to_booking');
  }
}
