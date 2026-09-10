import {IsEmail, MinLength, MaxLength, Matches} from 'class-validator';

// DTO audit P0-V1 — see RegisterVerifyDto. `role` + `subscriptionTier`
// removed from public registration so the unauthenticated surface
// cannot self-grant agent role or Pro tier.
export class RegisterDto {
  @IsEmail()      email!:            string;
  @MinLength(8)   password!:         string;
  @MinLength(1) @MaxLength(120) displayName!: string;
  @Matches(/^\+\d{7,15}$/) phoneE164!: string;
}
