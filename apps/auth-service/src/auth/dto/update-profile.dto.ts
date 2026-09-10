import {IsOptional, IsString, MaxLength} from 'class-validator';

/**
 * Self-service profile update for the authenticated user: display name and/or
 * avatar. Both fields are optional so a client can patch one without the other.
 * `avatar_url` may be `null` to clear the photo. It carries a small base64
 * data-URI (the client downscales to ~256px), so it's capped to keep the JSON
 * body and the `users.avatar_url` TEXT column bounded.
 */
export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(60)
  display_name?: string;

  @IsOptional() @IsString() @MaxLength(200_000)
  avatar_url?: string | null;
}
