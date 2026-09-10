import {ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsLatitude, IsLongitude, IsOptional, IsString, MaxLength, MinLength, Min, Max, ValidateNested} from 'class-validator';
import {Type} from 'class-transformer';

/**
 * Enroll the principal into VBG biometric liveness monitoring. The
 * `intervalMin` is the cadence at which the app prompts a face scan; a
 * lapsed window past the missed-scan threshold escalates to the Ops Room
 * via the existing SOS path. Coordinates are optional — carried so the
 * escalation can hand ops a last-known fix.
 */
export class EnrollMonitoringDto {
  // 15 min .. 24 h. Anything outside that is either spammy or useless as
  // a duress signal. ValidationPipe rejects non-integers / out-of-range.
  @IsOptional() @Type(() => Number) @IsInt() @Min(15) @Max(1440) intervalMin?: number;
  @IsOptional() @IsLatitude()  lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
}

/** Heartbeat carries an optional fresh fix so a later escalation is geolocated. */
export class HeartbeatDto {
  @IsOptional() @IsLatitude()  lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
}

/** BE-7.4 — biometric check-in result. */
export class BiometricCheckinDto {
  @IsIn(['pass', 'fail']) result!: 'pass' | 'fail';
  @IsOptional() @IsLatitude()  lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
}

/** BE-7.1 — encrypted telemetry body (AES-256-GCM, base64 iv‖ct‖tag). */
export class TelemetryDto {
  @IsString() @MaxLength(2048) sealed!: string;
}

/** BE-7.1 — panic. Optional last-known fix. */
export class PanicDto {
  @IsOptional() @IsLatitude()  lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
}

/** BE-7.3 — create a geofence from a ring of [lng,lat] points. */
export class CreateGeofenceDto {
  @IsString() @MaxLength(80) name!: string;
  @IsIn(['safe', 'danger']) kind!: 'safe' | 'danger';
  @IsArray() @ArrayMinSize(3) ring!: Array<[number, number]>;
}

export class TrackQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(86_400) sinceSec?: number;
}

/**
 * Query coords for the SRA snapshot / nearby key points. Query params
 * arrive as strings, so @Type coerces before @IsLatitude/@IsLongitude
 * range-check. Both optional — server falls back to a coarse default
 * when the client has no fix yet.
 *
 * GeoRisk search controls (BE-7.5):
 *  - `radiusKm` scopes the analysis ring (5 / 50 / 200 km from the GeoRisk
 *    UI; any 1..500 accepted). It biases key-point distance and the SRA
 *    summary copy.
 *  - `timeWindowHours` scopes the live-threat lookback (24 / 48 / 72 h),
 *    mapped to the GDELT `timespan`. Capped at 21 days so the upstream
 *    free-tier query stays valid.
 */
export class SraQueryDto {
  @IsOptional() @Type(() => Number) @IsLatitude()  lat?: number;
  @IsOptional() @Type(() => Number) @IsLongitude() lng?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)  @Max(500) radiusKm?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)  @Max(504) timeWindowHours?: number;
}

export class KeyPointsQueryDto {
  @IsOptional() @Type(() => Number) @IsLatitude()  lat?: number;
  @IsOptional() @Type(() => Number) @IsLongitude() lng?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) radiusKm?: number;
}

/**
 * General news feed query — CSV lists straight from the mobile News
 * Preferences screen. The service whitelists tokens (ISO2 / GLOBAL,
 * known category ids) and applies its own caps, so the DTO only bounds
 * shape and length.
 */
export class NewsFeedQueryDto {
  @IsOptional() @IsString() @MaxLength(120) countries?: string;
  @IsOptional() @IsString() @MaxLength(200) categories?: string;
}

/**
 * BE-7.6 — a single "Next of Kin" favorite. The phone is stored as typed
 * for display; the server derives the E.164 key. Loose phone validation
 * (digits + the usual punctuation) so users can enter local formats; the
 * Home action dials whatever was saved.
 */
export class FavoriteDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsString() @MinLength(3) @MaxLength(32) phone!: string;
}

/**
 * Replace-the-set semantics for the "Add 3 favorites" card: the client
 * sends the full list (0..3) and the server reconciles. An empty list
 * clears all favorites.
 */
export class SetFavoritesDto {
  @IsArray() @ArrayMaxSize(3)
  @ValidateNested({each: true}) @Type(() => FavoriteDto)
  favorites!: FavoriteDto[];
}
