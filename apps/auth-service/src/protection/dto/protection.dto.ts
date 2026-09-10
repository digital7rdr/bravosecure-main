import {Type} from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsISO8601, IsLatitude, IsLongitude,
  IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested,
} from 'class-validator';

/** Body for POST /protection/sessions — the ACTIVE plan to open a session against. */
export class CreateSessionDto {
  @IsUUID()
  application_id!: string;
}

/** One GPS fix. Batching is offline catch-up (edge E) — a stream of these arrives
 *  at once when a device comes back online. `recorded_at` is the device clock and
 *  is INFORMATIONAL; the server stamps `received_at` and all staleness uses that. */
export class LocationFixDto {
  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lng!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy_m?: number;

  @IsISO8601()
  recorded_at!: string;
}

/** Body for POST /protection/sessions/:id/locations — a batch of fixes. */
export class LocationBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({each: true})
  @Type(() => LocationFixDto)
  fixes!: LocationFixDto[];
}

/** Body for POST /ops/protection/sessions/:id/end — ops must state a reason. */
export class OpsEndSessionDto {
  @IsString()
  @MaxLength(280)
  reason!: string;
}

/** Body for POST /ops/protection/sessions/:id/transfer — edge J explicit transfer. */
export class TransferSessionDto {
  @IsUUID()
  new_cpo_user_id!: string;
}

/** Body for the in-session note endpoints (customer comment / officer reply). */
export class SessionNoteDto {
  @IsString()
  @MaxLength(500)
  body!: string;
}

/**
 * Body for the readiness endpoints. Each flag is what the OS told the app —
 * never the app's own opinion. The server derives `ready` from these, so a
 * client cannot assert readiness while a requirement is false.
 */
export class ReadinessDto {
  @IsBoolean() location_permission!: boolean;
  @IsBoolean() location_services!: boolean;
  @IsBoolean() precise_location!: boolean;
  @IsBoolean() connectivity!: boolean;
  /** True only after a real position was obtained — a rendered map is not evidence. */
  @IsBoolean() location_available!: boolean;
  @IsOptional() @IsString() @MaxLength(16) platform?: string;
}
