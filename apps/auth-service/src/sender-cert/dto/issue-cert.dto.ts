import {IsInt, IsString, Matches, Min, MinLength} from 'class-validator';

export class IssueSenderCertDto {
  @IsInt() @Min(1)
  senderSignalDeviceId!: number;

  /**
   * Base64-encoded Curve25519 identity public key (32 bytes -> 44 chars).
   * The cert binds this to the caller's `sub`, so peers can cross-check
   * the identity key they hold against what the server attests.
   */
  @IsString() @MinLength(40) @Matches(/^[A-Za-z0-9+/=]+$/)
  senderIdentityKey!: string;
}
