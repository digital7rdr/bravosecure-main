import {Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser}  from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {UsersService, type DiscoveredContact, type Me} from './users.service';
import {
  LookupUsersDto, UpdateMeDto, BlockUserDto, PrivacyDto, ProfilesByIdsDto, PreferencesDto,
} from './dto/lookup-users.dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * Directory lookup for "contacts on Bravo" discovery.
   *
   * Client uploads up to 500 E.164 numbers per call; throttled to 20 per
   * 10-minute window to prevent enumeration. Response includes ONLY
   * matches — unknown numbers never appear, so the endpoint can't be
   * abused as an existence oracle beyond whatever list the caller
   * already has. Blocked users (both directions) are filtered out.
   */
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @Throttle({default: {limit: 20, ttl: 600_000}})
  async lookup(
    @Body() dto: LookupUsersDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<{matches: DiscoveredContact[]}> {
    const matches = await this.users.lookupByPhones(dto.phones, user.sub);
    return {matches};
  }

  /**
   * Batch public-profile fetch by userId. Used to render member avatars
   * in chat info / group screens where the caller has userIds but not
   * phones. Same block filtering as /lookup; unknown ids are omitted.
   * Throttled to bound enumeration (the caller must already hold the ids).
   */
  @Post('profiles')
  @HttpCode(HttpStatus.OK)
  @Throttle({default: {limit: 60, ttl: 600_000}})
  async profiles(
    @Body() dto: ProfilesByIdsDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<{profiles: Array<{userId: string; displayName: string; avatarUrl: string | null}>}> {
    const profiles = await this.users.getProfilesByIds(dto.userIds, user.sub);
    return {profiles};
  }

  /** Current-user profile + privacy flags in one shot. */
  @Get('me')
  async me(@CurrentUser() user: AccessClaims): Promise<Me> {
    return this.users.getMe(user.sub);
  }

  /** Partial-update display_name / bio / avatar_url. */
  @Patch('me')
  async updateMe(
    @Body() dto: UpdateMeDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<Me> {
    return this.users.updateMe(user.sub, dto);
  }

  /** Partial-update privacy toggles. */
  @Patch('me/privacy')
  async updatePrivacy(
    @Body() dto: PrivacyDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<Me> {
    return this.users.updatePrivacy(user.sub, dto);
  }

  /** Step 25 — partial-update language / currency / notifications / location-scope /
   *  app-lock. The Safety notification category is coerced ON server-side. */
  @Patch('me/preferences')
  async updatePreferences(
    @Body() dto: PreferencesDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<Me> {
    return this.users.updatePreferences(user.sub, dto);
  }

  /** Block another user (pairwise). Idempotent. */
  @Post('block')
  async block(
    @Body() dto: BlockUserDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<{ok: true}> {
    await this.users.block(user.sub, dto.userId);
    return {ok: true};
  }

  /** Remove a block. Idempotent — unblocking a not-blocked user is a no-op. */
  @Delete('block/:userId')
  async unblock(
    @Param('userId') userId: string,
    @CurrentUser() user: AccessClaims,
  ): Promise<{ok: true}> {
    await this.users.unblock(user.sub, userId);
    return {ok: true};
  }

  /** List every user the caller has blocked. */
  @Get('blocked')
  async blocked(@CurrentUser() user: AccessClaims): Promise<{blocked: Array<{userId: string; displayName: string; avatarUrl: string | null}>}> {
    return {blocked: await this.users.listBlocked(user.sub)};
  }
}
