import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber,
  IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested,
} from 'class-validator';
import {Type} from 'class-transformer';

// Geotag bounds mirror the lat/lng validation pattern from agent.dto.ts so an
// out-of-Earth coordinate is rejected at the ValidationPipe, not the handler.
export class ClockInDto {
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)
  lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  lng?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000)
  accuracy_m?: number;

  // Dept Chat v2 (Step 5): verified check-in against an assigned shift.
  // shift_id is advisory — the server authoritatively resolves today's shift.
  @IsOptional() @IsUUID()
  shift_id?: string;
  // Result of the on-device face PRESENCE check (liveness only). The boolean is
  // the only biometric signal that crosses the wire — never frames/descriptors.
  @IsOptional() @IsBoolean()
  face_ok?: boolean;
  // D6-e — the camera/face step couldn't run (permission denied, no camera).
  // Distinct from face_ok===false so the review queue shows the right reason.
  @IsOptional() @IsBoolean()
  face_unavailable?: boolean;
  // Non-biometric audit metadata: { model, version, confidenceBucket }. 🛑 Must
  // NOT carry raw frames or face descriptors (enforced by the log-audit test).
  @IsOptional() @IsObject()
  face_meta?: Record<string, unknown>;
  // Client hint that this was an offline-queued submission → forces Pending Review.
  @IsOptional() @IsBoolean()
  offline?: boolean;
}

export class ClockOutDto {
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)
  lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  lng?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000)
  accuracy_m?: number;
  // PDF p.5 — face confirmation is required at check-OUT too. Same semantics as
  // ClockInDto: booleans only, never frames/descriptors.
  @IsOptional() @IsBoolean()
  face_ok?: boolean;
  @IsOptional() @IsBoolean()
  face_unavailable?: boolean;
}

// Member disputes their own attendance record (PDF p.8 support route).
export class DisputeSessionDto {
  @IsString() @Length(3, 500)
  note!: string;
}

// Provider edit of a shift (e.g. correcting a forgotten clock-out). Requires a
// reason for the audit trail; flips the row to status='edited'.
export class EditShiftDto {
  @IsOptional() @IsString() clock_in_at?: string;
  @IsOptional() @IsString() clock_out_at?: string;
  @IsString() @Length(3, 280) edit_reason!: string;
}

// ─── Dept Chat v2 · shift CRUD + assignment (Step 4) ─────────────────────────

// Manager creates an expected duty window + geofence centre + radius.
/** Q6 — one explicit window of a multi-date create. The CLIENT computes the
 *  concrete instants (it owns the manager's wall clock); the server never does
 *  timezone day-math. */
export class ShiftOccurrenceDto {
  @IsISO8601() start_at!: string;
  @IsISO8601() end_at!: string;
}

export class CreateShiftDto {
  @IsOptional() @IsString() @Length(1, 120) department?: string;
  @IsOptional() @IsString() @Length(1, 120) site_label?: string;
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)  site_lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) site_lng?: number;
  @IsOptional() @IsInt() @Min(10) @Max(10_000) approved_radius_m?: number;
  @IsISO8601() start_at!: string;
  @IsISO8601() end_at!: string;
  /** G-d — weekly repeat: N real rows at +7d·k sharing a recurrence group. */
  @IsOptional() @IsInt() @Min(2) @Max(12) repeat_weeks?: number;
  /** Q6 — multi-date create: N real rows, one per window, sharing a
   *  recurrence group. Mutually exclusive with repeat_weeks. start_at/end_at
   *  must still carry the FIRST window so an old server (which strips this
   *  field) degrades to creating that one shift, never a garbled one. */
  @IsOptional() @IsArray() @ArrayMaxSize(31)
  @ValidateNested({each: true}) @Type(() => ShiftOccurrenceDto)
  occurrences?: ShiftOccurrenceDto[];
  /** G-d — assignees created WITH the shift, one transaction (kills the
   *  create-then-assign orphan window; copied to every occurrence). */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('4', {each: true})
  cpo_user_ids?: string[];
  /** G-c — EXPANSION input, never scope: expands to the branch's active
   *  non-manager members and merges into the assignee set. A scoped manager
   *  may only expand their own branch (403 otherwise). */
  @IsOptional() @IsString() @Length(1, 120) assign_department?: string;
}

// Manager assigns active org CPOs to a shift. Cross-org ids are rejected at the
// service layer (cpo_not_active_member_of_org), not here.
export class AssignCposDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200)
  @IsUUID('4', {each: true})
  cpo_user_ids!: string[];
}

// Manager clears a Pending Review record (Step 6).
export class ReviewSessionDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';
  @IsOptional() @IsString() @Length(1, 500)
  notes?: string;
}

// G-ab — diff a shift's assignment set. No SCOPE department field ON PURPOSE:
// the branch scope is the manager's forced context (a body field would be the
// F HIGH-1 spoof surface). `assign_department` (G-c) is different in kind — an
// EXPANSION input naming a target set, validated against the manager's branch,
// never fed into any scope predicate.
export class PatchAssignmentsDto {
  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200) @IsUUID('4', {each: true})
  add?: string[];
  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200) @IsUUID('4', {each: true})
  remove?: string[];
  /** G-c — expands to the branch's active non-manager members, merged into
   *  `add`. Scoped managers may only expand their own branch. */
  @IsOptional() @IsString() @Length(1, 120) assign_department?: string;
}

/** A7.3 — the six manager-settable day statuses, in the PDF's order. This
 *  ORDER is load-bearing: dayStatusServerContract.test.ts compares this list,
 *  the service's marker IN-lists and the client's chips with toEqual. */
export const DAY_STATUSES = [
  'leave', 'sick_leave', 'emergency_leave', 'off_duty', 'absent', 'mission',
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

// Manager sets a non-check-in day status (Step 6; batch shape scope-v2 F).
// Exactly ONE targeting mode per call: legacy cpo_user_id | member_ids[] |
// department (server-expanded to its active non-manager members). Dates:
// legacy single `date` or explicit `dates[]` (the CLIENT expands ranges — the
// day-boundary logic stays in the one place that owns it, and the request is
// replayable). The service enforces mode exclusivity + targets×days ≤ 500.
export class SetDayStatusDto {
  @IsOptional() @IsUUID() cpo_user_id?: string;
  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(100) @IsUUID('4', {each: true})
  member_ids?: string[];
  @IsOptional() @IsString() @Length(1, 120)
  department?: string;
  @IsIn(DAY_STATUSES as unknown as string[])
  status!: DayStatus;
  @IsOptional() @IsISO8601() date?: string;
  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(62)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {each: true, message: 'dates must be YYYY-MM-DD'})
  dates?: string[];
  @IsOptional() @IsString() @Length(1, 500) notes?: string;
}

// Attendance export filters (Step 7). PDF is rendered client-side; the server
// emits CSV. Biometric data is never included.
export class ExportSessionsDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsUUID() cpo_user_id?: string;
  @IsOptional() @IsString() @Length(1, 120) department?: string;
  @IsOptional() @IsUUID() shift_id?: string;
}

// Manager patches a shift's window/site/geofence (all optional; audited).
export class UpdateShiftDto {
  @IsOptional() @IsString() @Length(1, 120) department?: string;
  @IsOptional() @IsString() @Length(1, 120) site_label?: string;
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)  site_lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) site_lng?: number;
  @IsOptional() @IsInt() @Min(10) @Max(10_000) approved_radius_m?: number;
  @IsOptional() @IsISO8601() start_at?: string;
  @IsOptional() @IsISO8601() end_at?: string;
}
