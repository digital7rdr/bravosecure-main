import {
  IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import {Type} from 'class-transformer';

export const AGENT_TYPES = ['company', 'cpo', 'transport'] as const;
export type AgentTypeDto = (typeof AGENT_TYPES)[number];

export const KYC_KINDS = ['gov_id', 'proof_address', 'sia_licence', 'police'] as const;
export type KycKind = (typeof KYC_KINDS)[number];

export const DOC_SLOTS = ['sia', 'passport', 'insurance', 'dbs', 'firstaid', 'cv'] as const;
export type DocSlot = (typeof DOC_SLOTS)[number];

export const DEPLOYMENT_CHECKS = ['dress', 'vehicle', 'equip', 'briefing'] as const;
export type DeploymentCheckKey = (typeof DEPLOYMENT_CHECKS)[number];

export const AVAILABILITY_MODES = ['full', 'part', 'oncall', 'project'] as const;
export type AvailabilityMode = (typeof AVAILABILITY_MODES)[number];

// ─── 01 · Agent Type ─────────────────────────────────────────────

export class CreateAgentDto {
  @IsEnum(AGENT_TYPES)
  type!: AgentTypeDto;

  @IsOptional() @IsString()
  display_name?: string;
}

// ─── Step 16 — on-arrival identity handshake (lead enters the client's code) ──
export class VerifyArrivalDto {
  @IsString() @Length(6, 6)
  code!: string;
}

// ─── 02 · Registration Wizard (Company) ──────────────────────────

export class UpdateCompanyDto {
  @IsOptional() @IsString()  legal_name?: string;
  @IsOptional() @IsString()  company_number?: string;
  @IsOptional() @IsString()  regulator?: string;
  @IsOptional() @IsString()  established?: string;
  @IsOptional() @IsString()  primary_contact?: string;
  @IsOptional() @IsString()  primary_email?: string;
  @IsOptional() @IsString()  primary_phone?: string;
  @IsOptional() @IsArray()   @IsString({each: true}) capabilities?: string[];
}

// ─── 04 · Coverage & Services ───────────────────────────────────

export class CoverageCountryDto {
  @IsString() code!: string;        // 'AE' | 'SA' | 'GB' | 'US'
  @IsBoolean() on!: boolean;
}
export class CoverageServiceDto {
  @IsString() key!: string;         // 'cp' | 'driving' | 'advance'
  @IsBoolean() on!: boolean;
}
export class UpdateCoverageDto {
  @IsArray() @ValidateNested({each: true}) @Type(() => CoverageCountryDto)
  countries!: CoverageCountryDto[];

  @IsArray() @ValidateNested({each: true}) @Type(() => CoverageServiceDto)
  services!: CoverageServiceDto[];
}

// ─── 05 · Availability ──────────────────────────────────────────

export class UpdateAvailabilityDto {
  @IsEnum(AVAILABILITY_MODES)
  mode!: AvailabilityMode;

  @IsArray() @IsString({each: true})
  loadout!: string[];     // ['armed','armoured','sia']
}

// ─── 06 · Documents ─────────────────────────────────────────────

export class UploadDocumentDto {
  @IsIn(DOC_SLOTS)
  slot!: DocSlot;

  @IsString()  title!: string;
  @IsString()  file_url!: string;
  @IsOptional() @IsString() file_hash_sha256?: string;
}

// ─── 03b · KYC supporting document upload ───────────────────────

export class UploadKycDocDto {
  @IsString()  file_url!: string;
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() file_hash_sha256?: string;
}

// ─── 07 · Admin Approval ────────────────────────────────────────

export class ReviewDecisionDto {
  @IsEnum(['APPROVED', 'REJECTED'] as const)
  decision!: 'APPROVED' | 'REJECTED';

  @IsOptional() @IsString() notes?: string;
}

export class ReviewStepPatchDto {
  @IsIn(['submit', 'docs', 'kyc', 'ops', 'partner'] as const)
  step!: 'submit' | 'docs' | 'kyc' | 'ops' | 'partner';

  @IsIn(['pending', 'in_progress', 'done', 'rejected'] as const)
  state!: 'pending' | 'in_progress' | 'done' | 'rejected';

  @IsOptional() @IsString() notes?: string;
}

// ─── 08 · Dashboard ─────────────────────────────────────────────

export class SetDutyDto {
  @IsBoolean() on_duty!: boolean;
}

// Bug 3 — the two dispatch-eligibility inputs (region_code + DPA) that no other
// agency screen writes. Captured on OrgComplianceScreen. Company agents only.
export class SetAgencyProfileDto {
  @IsString() @Length(2, 8) region_code!: string;
  @IsBoolean() dpa_accepted!: boolean;
  @IsOptional() @IsString() @MaxLength(32) dpa_version?: string;
}

export class BumpStatsDto {
  @IsOptional() @IsInt() @Min(0) @Max(10_000) duty_hours_delta?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) jobs_delta?: number;
}

// ─── Job Apply (with dress pledge) ──────────────────────────────

export class ApplyToJobDto {
  // What the agent says they'll actually wear / load out as. Audited
  // against booking.dress_instructions on the ops console. Min 4 chars
  // to block one-letter "ok" submissions while still allowing terse
  // pledges like "Black suit + tie".
  @IsString() @MinLength(4) dress_pledge!: string;
}

// ─── 09 · Deployment Checks ─────────────────────────────────────

export class DeploymentSignOffDto {
  @IsIn(DEPLOYMENT_CHECKS)
  check_key!: DeploymentCheckKey;

  @IsEnum(['passed', 'failed'] as const)
  state!: 'passed' | 'failed';

  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() mission_id?: string;
}

// ─── P0-V6 — agents.* mission-control DTOs ──────────────────────
// Previously inline `@Body() body: {...}` interfaces with hand-rolled
// shape checks (or none). Promoted to validated classes so the global
// ValidationPipe enforces shape + bounds — closes the gap the audit
// flagged where attacker-controlled payloads (lat/lng outside Earth,
// sub-200B reason strings, unbounded telemetry samples) reached the
// handler.

export class UpdateLocationDto {
  @IsNumber() @Min(-90)  @Max(90)
  lat!: number;
  @IsNumber() @Min(-180) @Max(180)
  lng!: number;
  // Step 23 anti-fraud — the duty heartbeat now reports fix quality so the server
  // can gate spoofed/implausible positions out of dispatch ranking.
  @IsOptional() @IsNumber() @Min(0) @Max(10_000)
  accuracy_m?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(500)
  speed_kph?: number;
  @IsOptional() @IsBoolean()
  is_mocked?: boolean;
}

export class RaiseSosDto {
  @IsString() @MinLength(1) @Length(1, 200)
  reason!: string;
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)
  lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  lng?: number;
}

export class MarkWaypointDto {
  @IsString() @Length(1, 64)
  tag!: string;
}

// LM-C3 — optional device fix carried on mission FSM transitions so the server
// can geofence-WARN (never block) a Start/Finish fired far from the point.
export class GeoFixDto {
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)
  lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  lng?: number;
}

export class PushTelemetryDto {
  @IsNumber() @Min(-90)  @Max(90)
  lat!: number;
  @IsNumber() @Min(-180) @Max(180)
  lng!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(360)
  heading_deg?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(500)
  speed_kph?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000)
  accuracy_m?: number;
  @IsOptional() @IsInt()    @Min(0) @Max(100)
  battery_pct?: number;
}
