import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString,
  Matches, MaxLength, Min, MinLength, Max,
} from 'class-validator';

export const PRO_INTENDED_USES = [
  'family_support', 'executive_protection', 'travel_protection',
  'residential_support', 'event_support', 'custom',
] as const;

export const PRO_GENDER_PREFS = ['no_preference', 'male', 'female', 'mixed'] as const;

/** Allow-list for the additional-services checkboxes (client + proposal). */
export const PRO_SERVICE_KEYS = [
  'secure_transfers', 'medical_support', 'advance_assessment',
  'secure_communications', 'journey_monitoring', 'event_support',
  'residential_support', 'other',
] as const;

export class CreateProApplicationDto {
  @IsIn(PRO_INTENDED_USES as unknown as string[])
  intended_use!: (typeof PRO_INTENDED_USES)[number];

  @IsOptional() @IsString() @MaxLength(300)
  intended_use_note?: string;

  @IsOptional() @IsInt() @Min(1) @Max(60)
  duration_months?: number;

  @IsOptional() @IsString() @MaxLength(300)
  duration_note?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  start_date!: string;

  @IsString() @MinLength(3) @MaxLength(300)
  coverage_area!: string;

  @IsInt() @Min(0) @Max(50) cpo_count!: number;
  @IsInt() @Min(0) @Max(50) driver_count!: number;
  @IsInt() @Min(0) @Max(50) support_staff_count!: number;

  @IsIn(PRO_GENDER_PREFS as unknown as string[])
  gender_preference!: (typeof PRO_GENDER_PREFS)[number];

  @IsArray() @ArrayMaxSize(12) @IsIn(PRO_SERVICE_KEYS as unknown as string[], {each: true})
  services!: string[];

  @IsOptional() @IsString() @MaxLength(300)
  service_other_note?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;
}

export class RequestChangesDto {
  @IsString() @MinLength(3) @MaxLength(2000)
  message!: string;
}

export class ProThreadMessageDto {
  @IsString() @MinLength(1) @MaxLength(2000)
  body!: string;
}

// ─── Ops DTOs ────────────────────────────────────────────────────────────────

export class CreateProposalDto {
  /** Total BC for the WHOLE coverage period (not monthly). */
  @IsInt() @Min(1) @Max(50_000_000)
  total_credits!: number;

  @IsDateString()
  valid_until!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  coverage_start!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  coverage_end!: string;

  @IsArray() @ArrayMaxSize(20) @IsString({each: true})
  included_services!: string[];

  /** [{role, count, label?}] — sanitised in the service (shape, caps). */
  @IsArray() @ArrayMaxSize(10)
  assigned_team!: Array<Record<string, unknown>>;

  @IsOptional() @IsString() @MaxLength(5000)
  terms?: string;

  /** Optional client-visible note added to the timeline with the proposal. */
  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class RejectProApplicationDto {
  @IsString() @MinLength(3) @MaxLength(1000)
  reason!: string;
}

export class CancelProApplicationDto {
  // Optional context for the timeline ("client called to withdraw").
  @IsOptional() @IsString() @MaxLength(500)
  note?: string | null;
}

export class CreateProMissionDto {
  /** YYYY-MM-DD, all inside the plan's coverage period. */
  @IsArray() @ArrayMaxSize(31) @Matches(/^\d{4}-\d{2}-\d{2}$/, {each: true})
  dates!: string[];

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class ScheduleProMissionDto {
  /** [{role, count, label?}] — sanitised in the service. */
  @IsOptional() @IsArray() @ArrayMaxSize(10)
  assigned_team?: Array<Record<string, unknown>>;

  @IsOptional() @IsString() @MaxLength(1000)
  ops_note?: string;
}

export class DeclineProMissionDto {
  @IsOptional() @IsString() @MaxLength(1000)
  ops_note?: string;
}

export class InternalNotesDto {
  @IsString() @MaxLength(5000)
  notes!: string;
}
