import {IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength} from 'class-validator';

/**
 * Scope v2 Phase 5 DTOs.
 *
 * NOTE what is deliberately ABSENT: neither DTO accepts a `department`, an
 * `org_user_id`, or a `corrected_at`. The branch comes from the manager's own
 * context (a forced filter), the org from the guard, and the correction time
 * from the database's NOW() — A7.4 says "when (SERVER time)". A field the API
 * does not accept cannot be spoofed by a hostile body, and cannot be
 * accidentally honoured by a later edit.
 */
export class EnsureMonthDto {
  /** Any date inside the month; the service normalises to the first. */
  @IsString()
  @Matches(/^\d{4}-\d{2}(-\d{2})?$/, {message: 'month must be YYYY-MM or YYYY-MM-DD'})
  month!: string;
}

export class PublishMonthDto {
  /** Any date inside the month; the service normalises to the first. */
  @IsString()
  @Matches(/^\d{4}-\d{2}(-\d{2})?$/, {message: 'month must be YYYY-MM or YYYY-MM-DD'})
  month!: string;

  /**
   * Publish despite conflicts. A real roster sometimes has a deliberate
   * double-booking — but it must be an explicit choice, and it is recorded in
   * the audit rather than silently permitted.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class RecordCorrectionDto {
  @IsUUID()
  session_id!: string;

  /**
   * WHY. Required and length-bounded: A7.4's whole point is that a correction
   * carries a reason, and "" would make the record indistinguishable from the
   * silent overwrite this replaces. The DB has the same CHECK.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  /**
   * The corrected values. The service intersects this with the fields a
   * correction may touch and drops no-ops, so an unknown key here changes
   * nothing rather than being written through.
   */
  @IsObject()
  after!: Record<string, unknown>;
}

/** The attendance statuses a correction may set — the same set the session
 *  column's CHECK allows. Exported so the service and any future caller share
 *  one list rather than drifting copies. */
export const CORRECTABLE_STATUSES = [
  'present', 'late', 'absent', 'early_checkout',
  'leave', 'sick_leave', 'off_duty', 'pending_review',
  'emergency_leave', 'mission',
] as const;

export class CorrectionStatusDto {
  @IsIn(CORRECTABLE_STATUSES as unknown as string[])
  attendance_status!: string;
}
