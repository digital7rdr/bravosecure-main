import {IsString, MinLength} from 'class-validator';

/**
 * Audit P0-A5 — credential rotation. The user proves possession of the
 * current password before any change so a stolen access token alone
 * can't lock the legitimate user out. After verification, every device
 * session is revoked so a compromised session does not survive the
 * rotation (the entire reason a user changes their password).
 */
export class ChangePasswordDto {
  @IsString() @MinLength(1)  currentPassword!: string;
  @IsString() @MinLength(8)  newPassword!:     string;
}
