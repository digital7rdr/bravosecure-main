import {IsDateString, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, Max} from 'class-validator';

export class InviteMemberDto {
  // E.164 — same shape the messenger contact lookup normalises to.
  @Matches(/^\+\d{6,15}$/, {message: 'phoneE164 must be E.164'}) phoneE164!: string;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) spendLimitCredits?: number | null;
  /** Owner-declared relationship (badge on the member row). */
  @IsOptional() @IsString() @MaxLength(40) relationship?: string | null;
}

export class SetSpendLimitDto {
  // null clears the cap (unlimited within the holder's balance).
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) spendLimitCredits?: number | null;
  /** Optional note recorded on the quota-audit row (spec §37). */
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
}

/**
 * Spec §11 — a member asks the holder for more spending credit.
 *
 * Note what is NOT here: memberId, rootAccountId, quota, remaining or used.
 * Every one of those is derived server-side from the authenticated user (§38),
 * so there is nothing in this body a malicious member could rewrite to charge
 * another family or grant themselves a limit.
 *
 * `@IsInt` + `@Min(1)` is the §30 gate at the edge: 0, negatives, decimals,
 * NaN and Infinity are all rejected before a service method sees them. The
 * service re-validates with `normalizeCredits` regardless — the DTO is a
 * convenience, not the authority.
 */
export class RequestCreditDto {
  @IsInt() @Min(1) @Max(1_000_000) requestedCredits!: number;
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
}

/** Spec §14 — omit `approvedCredits` to approve in full; supply less for a partial. */
export class ApproveCreditDto {
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) approvedCredits?: number | null;
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
}

/** Spec §15 — the holder may attach a reason the member sees. */
export class RejectCreditDto {
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
}

export class SetHoldDto {
  // ISO instant the hold lasts until; omit/null lifts the hold.
  @IsOptional() @IsDateString() heldUntilIso?: string | null;
}

export class InviteActionDto {
  @IsString() inviteId!: string;
}

export class ReportLocationDto {
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) accuracyM?: number | null;
}
