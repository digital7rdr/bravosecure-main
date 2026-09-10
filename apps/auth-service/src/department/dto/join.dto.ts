import {IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min} from 'class-validator';

/**
 * Enterprise Dept Channels scope v2 — Phase 3 request bodies (M5 / A11).
 */

export class CreateReferralLinkDto {
  /** M5 — "The link records the Enterprise, referrer and exact originating
   *  team." The team is a channel in THIS org (server-verified). */
  @IsOptional() @IsUUID()
  team_channel_id?: string;

  @IsOptional() @IsInt() @Min(1) @Max(90)
  expires_in_days?: number;
}

export class SubmitJoinRequestDto {
  @IsString() @Length(4, 32)
  code!: string;

  // M5 — "Confirm only full name, mobile and email; no OTP is used in this flow."
  @IsOptional() @IsString() @MaxLength(120)
  full_name?: string;

  @IsOptional() @IsString() @MaxLength(32)
  phone?: string;

  @IsOptional() @IsEmail() @MaxLength(160)
  email?: string;

  @IsOptional() @IsString() @MaxLength(500)
  message?: string;

  // ⚠️ There is deliberately NO team/department field.
  //
  // M5: "The applicant cannot change the requested department or team." The team
  // is read from the LINK server-side. Accepting one here — even to ignore it —
  // would invite a future edit to start honouring it.
}

/** Item E (A5-inv) — invite a specific person by phone OR email. */
export class CreateMemberInviteDto {
  /** E.164, normalised by the CLIENT (B-154) — the server refuses, never
   *  guesses, a missing country prefix. */
  @IsOptional() @IsString() @MaxLength(20)
  contact_phone?: string;

  @IsOptional() @IsEmail() @MaxLength(160)
  contact_email?: string;

  @IsOptional() @IsString() @MaxLength(120)
  invited_name?: string;

  @IsOptional() @IsUUID()
  team_channel_id?: string;

  @IsOptional() @IsIn(['employee', 'manager'])
  invited_role?: 'employee' | 'manager';

  /** Branch scope — service-side rule: only with invited_role 'manager'. */
  @IsOptional() @IsString() @MaxLength(80)
  invited_department?: string;

  @IsOptional() @IsInt() @Min(1) @Max(90)
  expires_in_days?: number;
}

export class AcceptInviteDto {
  @IsString() @Length(4, 32)
  code!: string;
}
