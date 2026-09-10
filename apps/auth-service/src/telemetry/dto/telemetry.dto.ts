import {IsInt, IsNumber, IsOptional, IsString, Max, Min} from 'class-validator';

/** POST /telemetry/:bookingId/ping — agent writes a single GPS fix. */
export class TelemetryPingDto {
  @IsNumber() @Min(-90)  @Max(90)    lat!: number;
  @IsNumber() @Min(-180) @Max(180)   lng!: number;

  @IsOptional() @IsNumber() @Min(0) @Max(360)  heading_deg?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(500)  speed_kph?: number;
  @IsOptional() @IsInt()    @Min(0) @Max(24 * 60)
  eta_minutes?: number;

  @IsOptional() @IsString() source?: string;
}
