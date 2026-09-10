import {IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength} from 'class-validator';

// Channels Hub v2 (PDF p.4). Type drives the Board/Department/Incident grouping;
// access drives the read-only/restricted badges + manager-only seeding. These
// mirror the CHECK constraints in 20260629000002_channel_types.sql.
export const CHANNEL_TYPES = ['board', 'department', 'incident'] as const;
export const CHANNEL_ACCESS = ['standard', 'read_only', 'restricted'] as const;
// Scope v2 Phase 2 — POSTING rights, separate from `access` (visibility).
// Frame A9: "Open Chat, Read-only, Announcement-only and Admin-only modes."
// Mirrors the CHECK in 20260803020000_dept_channel_post_mode.sql.
export const CHANNEL_POST_MODES = ['open', 'read_only', 'announcement', 'admin_only'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export type ChannelAccess = (typeof CHANNEL_ACCESS)[number];
export type ChannelPostMode = (typeof CHANNEL_POST_MODES)[number];

export const MEMBER_ROLES = ['admin', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

// Manager/company-admin creates a channel (OrgManagerGuard). Defaults match the
// migration defaults so an omitted type/access reads as a normal dept channel.
export class CreateChannelDto {
  @IsString() @Length(1, 80)
  name!: string;

  @IsOptional() @IsString() @Length(1, 80)
  department?: string;

  @IsOptional() @IsIn(CHANNEL_TYPES as unknown as string[])
  channel_type?: ChannelType;

  @IsOptional() @IsIn(CHANNEL_ACCESS as unknown as string[])
  access?: ChannelAccess;

  // Scope v2 Phase 1 — parent in the four-level hierarchy. Omitted = a
  // top-level (Main) channel, which is how every pre-hierarchy channel reads.
  // There is deliberately NO `level` field: level is derived from the parent by
  // a DB trigger, so a caller cannot assert its own depth.
  @IsOptional() @IsUUID()
  parent_id?: string;

  // vs2 item 8 — "+ Create new organisation" mints a TRUE root (level 0) rather
  // than another level-1 Main. A BOOLEAN, deliberately, not a level: level is
  // trigger-derived everywhere else, and accepting an integer here would hand a
  // caller the one column the depth CHECK depends on. Ignored when parent_id is
  // present — a row with a parent is never a root.
  @IsOptional() @IsBoolean()
  root?: boolean;

  // Scope v2 Phase 2 — POSTING rights. Separate field from `access` on purpose:
  // access answers "who can see it", this answers "who can post in it".
  // Omitted = read_only, which is exactly how every channel behaves today.
  // There is deliberately NO `is_broadcast` field — a #broadcast is created by
  // the server's ensureBroadcastForLevel, never asserted by a caller.
  @IsOptional() @IsIn(CHANNEL_POST_MODES as unknown as string[])
  post_mode?: ChannelPostMode;

  /**
   * UI corrections 2026-08-15 item 04 — create this as a LATERAL channel:
   * attached to `parent_id`'s level without consuming a hierarchy tier.
   *
   * A BOOLEAN, like `root`, and for the same reason: `level` is trigger-derived
   * everywhere else, and accepting an integer would hand a caller the one column
   * the depth CHECK depends on. Requires `parent_id` (a parentless lateral has no
   * level to be lateral to). Workspace tenants only — an agency's per-level
   * #broadcast arithmetic assumes every child increments the level.
   *
   * ⚠️ The response echoes `is_lateral` back. In PRODUCTION `forbidNonWhitelisted`
   * is false, so an OLD server silently STRIPS this field and creates a
   * structural child instead — unfixable afterwards, because is_lateral is frozen
   * and re-parenting is blocked. The client must verify the echo, not assume.
   */
  @IsOptional() @IsBoolean()
  lateral?: boolean;
}

// Partial update — every field optional; only the supplied ones change
// (COALESCE in the service). Tightening `access` to restricted/incident also
// rekeys non-manager members out via the existing removeMember path.
export class ConfigureChannelDto {
  @IsOptional() @IsString() @Length(1, 80)
  name?: string;

  // D7-c — allow an empty string so the department CAN be cleared (the service treats
  // '' as the explicit-clear sentinel). MaxLength only (no min) instead of Length(1,80).
  @IsOptional() @IsString() @MaxLength(80)
  department?: string;

  @IsOptional() @IsIn(CHANNEL_TYPES as unknown as string[])
  channel_type?: ChannelType;

  @IsOptional() @IsIn(CHANNEL_ACCESS as unknown as string[])
  access?: ChannelAccess;

  // Phase 2 — changing posting rights re-seeds member roles (see
  // configureChannel). No `is_broadcast` here either: a broadcast cannot be
  // demoted into an ordinary channel by an update.
  @IsOptional() @IsIn(CHANNEL_POST_MODES as unknown as string[])
  post_mode?: ChannelPostMode;
}

// D4-e — validated bodies for the membership/group endpoints that previously took
// unvalidated inline `@Body() body: {...}` types (registerGroup / addMember / updateMemberRole).
export class RegisterGroupDto {
  @IsString() @Length(1, 200)
  group_conversation_id!: string;
}

export class AddMemberDto {
  @IsUUID()
  user_id!: string;

  @IsOptional() @IsIn(MEMBER_ROLES as unknown as string[])
  role?: MemberRole;

  @IsOptional() @IsString() @MaxLength(60)
  role_label?: string;
}

export class UpdateMemberRoleDto {
  @IsIn(MEMBER_ROLES as unknown as string[])
  role!: MemberRole;
}
