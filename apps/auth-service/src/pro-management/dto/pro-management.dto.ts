import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString,
  IsUUID, Matches, MaxLength, Min, MinLength, Max,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateInternalOrgDto {
  @IsString() @MinLength(2) @MaxLength(120) display_name!: string;
  @IsEmail() email!: string;
  @Matches(/^\+\d{6,15}$/) phone_e164!: string;
  @IsString() @MinLength(8) @MaxLength(72) temp_password!: string;
  /** ISO country the org covers (managed CPOs inherit it). Default AE. */
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) coverage_country?: string;
}

export class CreateOpsCpoDto {
  @IsUUID() org_user_id!: string;
  @IsString() @MinLength(2) @MaxLength(120) display_name!: string;
  @IsEmail() email!: string;
  @Matches(/^\+\d{6,15}$/) phone_e164!: string;
  @IsString() @MinLength(8) @MaxLength(72) temp_password!: string;
  @IsOptional() @IsString() @MaxLength(24) call_sign?: string;
}

export class SuspendCpoDto {
  @IsBoolean() suspend!: boolean;
  /** Days from now; omit for indefinite. */
  @IsOptional() @IsInt() @Min(1) @Max(365) days?: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class CreateProAssignmentDto {
  @IsUUID() application_id!: string;
  @IsOptional() @IsUUID() mission_id?: string;
  @IsUUID() cpo_user_id!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) starts_on!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) ends_on!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class ScheduleRequestWithCposDto {
  @IsArray() @ArrayMaxSize(10) @IsUUID(undefined, {each: true})
  cpo_user_ids!: string[];
  @IsOptional() @IsString() @MaxLength(1000) ops_note?: string;
}

export class MissionCodeDto {
  @IsString() @MinLength(4) @MaxLength(16) code!: string;
}

// ─── Issue 30 — Pro fleet + resources ────────────────────────────────────────

export class CreateProFleetVehicleDto {
  @IsString() @MinLength(1) @MaxLength(24) call_sign!: string;
  @IsString() @MinLength(1) @MaxLength(120) make_model!: string;
  @IsString() @MinLength(1) @MaxLength(24) plate!: string;
  @IsOptional() @IsString() @MaxLength(40) colour?: string;
  @IsOptional() @IsBoolean() armored?: boolean;
  @IsOptional() @IsString() @MaxLength(40) armor_grade?: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) capacity?: number;
  @IsOptional() @IsString() @MaxLength(8) region_code?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

/** Partial update / retire (active=false). Every field optional. */
export class UpdateProFleetVehicleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(24) call_sign?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) make_model?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(24) plate?: string;
  @IsOptional() @IsString() @MaxLength(40) colour?: string;
  @IsOptional() @IsBoolean() armored?: boolean;
  @IsOptional() @IsString() @MaxLength(40) armor_grade?: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) capacity?: number;
  @IsOptional() @IsString() @MaxLength(8) region_code?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class CreateProResourceDto {
  @IsIn(['comms', 'medical', 'tactical', 'other']) kind!: string;
  @IsString() @MinLength(1) @MaxLength(120) label!: string;
  /** Ops-internal serial — never projected to the client. */
  @IsOptional() @IsString() @MaxLength(120) identifier?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class UpdateProResourceDto {
  @IsOptional() @IsIn(['comms', 'medical', 'tactical', 'other']) kind?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) label?: string;
  @IsOptional() @IsString() @MaxLength(120) identifier?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class AssignProVehicleDto {
  @IsUUID() vehicle_id!: string;
  @Matches(DATE_RE) starts_on!: string;
  @Matches(DATE_RE) ends_on!: string;
  @IsOptional() @IsUUID() assignment_id?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class AssignProResourceDto {
  @IsUUID() resource_id!: string;
  @IsOptional() @IsInt() @Min(1) @Max(999) qty?: number;
  @Matches(DATE_RE) starts_on!: string;
  @Matches(DATE_RE) ends_on!: string;
  @IsOptional() @IsUUID() assignment_id?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
