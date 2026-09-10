import {IsIn, IsOptional, IsString, MaxLength} from 'class-validator';

/** Dispute categories (BUILD_RUNBOOK Step 11 §41 / booking_disputes.category). */
export const DISPUTE_CATEGORIES = ['not_performed', 'left_early', 'wrong_guard', 'conduct', 'billing'] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

const REASON_MAX = 1024;

export class CreateDisputeDto {
  @IsIn(DISPUTE_CATEGORIES) category!: DisputeCategory;
  @IsOptional() @IsString() @MaxLength(REASON_MAX) reason?: string;
}
