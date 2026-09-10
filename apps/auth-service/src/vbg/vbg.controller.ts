import {Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard}       from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentUser}        from '../common/decorators/current-user.decorator';
import type {AccessClaims}  from '../auth/jwt.service';
import {VbgService}         from './vbg.service';
import {GeofenceService}    from './geofence.service';
import {GeocodeService}     from './geocode.service';
import {
  EnrollMonitoringDto, HeartbeatDto, KeyPointsQueryDto, SraQueryDto,
  BiometricCheckinDto, TelemetryDto, PanicDto, CreateGeofenceDto, TrackQueryDto,
  SetFavoritesDto,
} from './dto/vbg.dto';

/**
 * Virtual Bodyguard endpoints. JWT-guarded + per-user throttled, same as
 * the SOS controller. Everything is scoped to `user.sub`; no endpoint
 * accepts a foreign user id.
 */
@Controller('vbg')
// Guard order matters: JwtAuthGuard runs first so req.user is populated,
// then UserThrottlerGuard tracks per-user.
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class VbgController {
  constructor(
    private readonly vbg: VbgService,
    private readonly geofence: GeofenceService,
    private readonly geo: GeocodeService,
  ) {}

  /**
   * Lightweight reverse geocode (cached ~1km-snap) — the booking zone screen
   * resolves the principal's CURRENT COUNTRY from a GPS fix without paying
   * for a full SRA. Missing/invalid coords return the service's honest
   * fallback (country: null) rather than erroring.
   */
  @Get('geocode')
  geocode(@Query() q: SraQueryDto) {
    return this.geo.reverse(q.lat ?? Number.NaN, q.lng ?? Number.NaN);
  }

  @Post('monitoring/enroll')
  enroll(@Body() dto: EnrollMonitoringDto, @CurrentUser() user: AccessClaims) {
    // Pass the device id so a per-device telemetry key is minted + returned.
    return this.vbg.enrollMonitoring(user.sub, {...dto, deviceId: user.deviceId});
  }

  // A duress heartbeat can fire on a tight cadence (hourly by default,
  // but re-tries on flaky networks), so the bucket is generous. The
  // missed-scan escalation it can trigger is itself SOS-throttled.
  @Throttle({default: {limit: 12, ttl: 60_000}})
  @Post('monitoring/heartbeat')
  heartbeat(@Body() dto: HeartbeatDto, @CurrentUser() user: AccessClaims) {
    return this.vbg.heartbeat(user.sub, dto);
  }

  /** BE-7.4 — biometric check-in; 3 consecutive fails → escalation. */
  @Throttle({default: {limit: 12, ttl: 60_000}})
  @Post('biometric/checkin')
  biometricCheckin(@Body() dto: BiometricCheckinDto, @CurrentUser() user: AccessClaims) {
    // Escalation SMS recipients (Next-of-Kin favorites, fallback principal)
    // are resolved inside the service — audit H-4.
    return this.vbg.biometricCheckin(user.sub, dto);
  }

  @Get('monitoring/status')
  status(@CurrentUser() user: AccessClaims) {
    return this.vbg.monitoringStatus(user.sub);
  }

  // BE-7.1 — encrypted telemetry, ~every 3s. Generous bucket (1 every ~2.4s).
  @Throttle({default: {limit: 25, ttl: 60_000}})
  @Post('telemetry')
  telemetry(@Body() dto: TelemetryDto, @CurrentUser() user: AccessClaims) {
    return this.vbg.ingestTelemetry(user.sub, user.deviceId, dto.sealed);
  }

  /** BE-7.2 — recent GPS track for the live map. */
  @Get('track')
  track(@Query() q: TrackQueryDto, @CurrentUser() user: AccessClaims) {
    return this.vbg.track(user.sub, q.sinceSec).then(fixes => ({fixes}));
  }

  /** BE-7.1 — panic → SOS + SMS + WS, all within the request. */
  @Throttle({default: {limit: 3, ttl: 60_000}})
  @Post('panic')
  panic(@Body() dto: PanicDto, @CurrentUser() user: AccessClaims) {
    return this.vbg.panic(user.sub, dto);
  }

  // BE-7.3 — geofence CRUD.
  @Get('geofences')
  listGeofences(@CurrentUser() user: AccessClaims) {
    return this.geofence.listZones(user.sub).then(zones => ({zones}));
  }

  @Post('geofences')
  createGeofence(@Body() dto: CreateGeofenceDto, @CurrentUser() user: AccessClaims) {
    return this.geofence.createZone(user.sub, dto);
  }

  @Delete('geofences/:id')
  async deleteGeofence(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    await this.geofence.deleteZone(user.sub, id);
    return {ok: true};
  }

  @Get('sra')
  sra(@Query() q: SraQueryDto, @CurrentUser() user: AccessClaims) {
    return this.vbg.sraSnapshot(user.sub, q);
  }

  /** Live region-based threat feed (GPS → region → GDELT) for the OSINT screen. */
  @Get('threats')
  threats(@Query() q: SraQueryDto) {
    return this.vbg.regionThreats({lat: q.lat, lng: q.lng, timeWindowHours: q.timeWindowHours});
  }

  @Get('keypoints')
  async keypoints(@Query() q: KeyPointsQueryDto) {
    return {keypoints: await this.vbg.keyPoints(q)};
  }

  /** BE-7.6 — Next-of-Kin favorites. Server-backed so they survive reinstall. */
  @Get('favorites')
  async listFavorites(@CurrentUser() user: AccessClaims) {
    return {favorites: await this.vbg.listFavorites(user.sub)};
  }

  /** Replace-the-set save (0..3). Returns the persisted list. */
  @Put('favorites')
  async setFavorites(@Body() dto: SetFavoritesDto, @CurrentUser() user: AccessClaims) {
    return {favorites: await this.vbg.setFavorites(user.sub, dto.favorites)};
  }
}
