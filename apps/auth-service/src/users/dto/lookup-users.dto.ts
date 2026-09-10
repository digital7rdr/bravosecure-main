import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString,
  IsUUID, Length, Matches, MaxLength,
} from 'class-validator';

/**
 * Client sends a list of phone numbers read from the local address book,
 * already normalized to E.164 by the client. The server refuses any
 * entry that doesn't match `^\+\d{7,15}$` (same regex `RegisterDto` uses
 * so we never disagree on what "a phone number" is).
 *
 * Batch cap (500) bounds the per-request work; typical address books
 * land well below this. Clients with larger books chunk on their side.
 */
export class LookupUsersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({each: true})
  @Matches(/^\+\d{7,15}$/, {each: true, message: 'each phone must be E.164 (+<digits>)'})
  phones!: string[];
}

/**
 * POST /users/profiles — batch fetch public profile fields (displayName,
 * avatarUrl) for a set of userIds. Used to render member avatars in chat
 * info / group screens where the caller has the userIds but not phones.
 * Returns only non-blocked users; unknown ids are simply absent. Capped
 * at 500 to bound per-request work.
 */
export class ProfilesByIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', {each: true})
  userIds!: string[];
}

/**
 * PATCH /users/me — partial-update profile. Every field is optional so
 * clients can send only what they changed. `null` on avatar_url clears
 * the image; `undefined` leaves it alone.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  avatarUrl?: string | null;
}

export class BlockUserDto {
  @IsUUID()
  userId!: string;
}

export class PrivacyDto {
  @IsOptional()
  @IsBoolean()
  lastSeenVisible?: boolean;

  @IsOptional()
  @IsBoolean()
  readReceiptsEnabled?: boolean;
}

/**
 * PATCH /users/me/preferences (Step 25) — language / currency / notification
 * categories / location-sharing scope / app-lock. Every field optional (partial
 * update). The server FORCES notif_prefs.safety = true regardless of input so a
 * user can never silence a safety alert.
 */
export class PreferencesDto {
  @IsOptional()
  @IsIn(['en', 'ar', 'bn'])
  language?: 'en' | 'ar' | 'bn';

  @IsOptional()
  @IsIn(['AED', 'SAR', 'BDT', 'GBP'])
  currency?: 'AED' | 'SAR' | 'BDT' | 'GBP';

  // A category→enabled map, e.g. {trip: true, marketing: false}. `safety` is coerced
  // on by the server. Values are booleans; unknown categories are accepted + stored.
  @IsOptional()
  @IsObject()
  notifPrefs?: Record<string, boolean>;

  @IsOptional()
  @IsIn(['while_on_duty', 'during_mission', 'never'])
  locationScope?: 'while_on_duty' | 'during_mission' | 'never';

  @IsOptional()
  @IsBoolean()
  appLock?: boolean;

  // REGION (#8) — persisted home region; 'N/A' = outside supported coverage.
  @IsOptional()
  @IsIn(['AE', 'SA', 'BD', 'GB', 'ZA', 'N/A'])
  homeRegion?: 'AE' | 'SA' | 'BD' | 'GB' | 'ZA' | 'N/A';
}
