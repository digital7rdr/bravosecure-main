import {IsOptional, IsString, Matches, MinLength} from 'class-validator';

/** Same shape the client keypad produces; server-validated so a raw API
 *  caller cannot store an un-typeable verifier. */
const PIN_RE = /^\d{4,8}$/;

export class SetVaultPinDto {
  @Matches(PIN_RE) pin!: string;
  /**
   * Required when a verifier already exists (replace). Absent on first set.
   * The OTP reset flow replaces WITHOUT it via its own token-gated endpoint.
   */
  @IsOptional() @Matches(PIN_RE) currentPin?: string;
}

export class VerifyVaultPinDto {
  @Matches(PIN_RE) pin!: string;
}

export class VaultPinResetRequestDto {
  /** Audit S2 — the account PASSWORD is the factor a phone-holder lacks. */
  @IsString() @MinLength(1) password!: string;
}

export class VaultPinResetVerifyDto {
  @Matches(/^\d{4,8}$/) code!: string;
}

export class VaultPinResetCompleteDto {
  @IsString() @MinLength(1) resetToken!: string;
  @Matches(PIN_RE) pin!: string;
}
