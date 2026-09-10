import {IsUUID, IsOptional, IsEmail, IsString, MinLength, MaxLength, Matches, IsIn} from 'class-validator';

// DTO audit P0-V1 — `role` and `subscriptionTier` REMOVED from the
// public registration body. The previous DTO accepted both with
// `@IsOptional() @IsIn([...])` and the service wrote them straight
// into `public.users`, which meant any unauthenticated registration
// could self-grant `role='agent'` (the FSM-gated partner role) AND
// `subscription_tier='pro'` (a paid SKU). Role flips now happen only
// via the `/agents` create + ops `/ops/agents/:id/decide` flow; Pro
// upgrades go through the wallet / Stripe path. Registration
// inserts the defaults server-side ('individual', 'lite') in
// auth.service.registerVerify.
export class RegisterVerifyDto {
  @IsEmail()       email!:       string;
  @MinLength(8)    password!:    string;
  @MinLength(1) @MaxLength(120) displayName!: string;
  @Matches(/^\+\d{7,15}$/) phoneE164!: string;

  @Matches(/^\d{4,8}$/)                     code!:     string;
  @IsString() @MinLength(1) @MaxLength(128) deviceId!: string;
  @IsIn(['ios','android','web'])            platform!: string;
  // TOTP mode only — the id /auth/register returned. See VerifyDto.
  @IsOptional() @IsUUID()                   challengeId?: string;
}
