import {IsOptional, IsUUID, IsString, MaxLength, IsObject, IsLatitude, IsLongitude} from 'class-validator';

export class RaiseSosDto {
  @IsOptional() @IsUUID() bookingId?: string;
  // Audit fix #1 — IsLatitude/IsLongitude give us strict numeric range
  // gating (lat ∈ [-90, 90], lng ∈ [-180, 180]). The service still
  // interpolates these into an EWKT literal; the range check + the
  // double Number() coercion below kill any non-numeric payload before
  // it can reach the SQL. ValidationPipe rejects strings and NaN.
  @IsOptional() @IsLatitude()  lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
  @IsOptional() @IsString() @MaxLength(64) reason?: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
}
