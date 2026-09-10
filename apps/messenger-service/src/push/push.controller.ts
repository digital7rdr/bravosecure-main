import {Body, Controller, Delete, Get, Post, UseGuards} from '@nestjs/common';
import {IsIn, IsString, MinLength, MaxLength, Matches} from 'class-validator';
import {JwtHttpGuard} from '../common/guards/jwt-http.guard';
import {AppCheckGuard} from '../common/guards/app-check.guard';
import {CurrentCaller} from '../common/decorators/current-caller.decorator';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import {PushService, type PushPlatform} from './push.service';

class RegisterTokenDto {
  @IsString() @IsIn(['ios', 'android'])
  platform!: PushPlatform;

  @IsString() @MinLength(10) @MaxLength(4096)
  @Matches(/^[A-Za-z0-9+/=_\-.:]+$/)
  token!: string;
}

@Controller('push')
// Audit P0-N9 — App Check / Apple App Attest gate. The JWT proves
// "I have an authed account" but does NOT prove "this request came
// from the legit Bravo Secure binary on a non-rooted device." Without
// this, any authed user could register an attacker-controlled FCM/APNs
// token in the victim's slot. AUDIT #6: in production an unset/typo'd
// APP_CHECK_MODE FAILS CLOSED on these routes only (401 + boot-level
// error; the process never dies for this guard). Run warn-only until
// clients ship the X-Firebase-AppCheck header, then flip to enforce.
@UseGuards(JwtHttpGuard, AppCheckGuard)
export class PushController {
  constructor(private readonly push: PushService) {}

  @Post('register')
  async register(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: RegisterTokenDto,
  ): Promise<{ok: true}> {
    // Audit P0-N2 — pass the caller's JTI so the GC can detect
    // revoked sessions and drop orphaned push tokens.
    await this.push.registerDeviceToken({
      userId:    caller.claims.sub,
      deviceId:  caller.claims.deviceId,
      platform:  dto.platform,
      token:     dto.token,
      updatedAt: Date.now(),
    }, caller.claims.jti);
    return {ok: true};
  }

  @Delete('register')
  async unregister(@CurrentCaller() caller: CallerContext): Promise<{ok: true}> {
    await this.push.unregisterDeviceToken(caller.claims.sub, caller.claims.deviceId);
    return {ok: true};
  }

  /**
   * BE-4.3: VoIP-specific token registration.
   * iOS MUST use this for PushKit tokens (distinct from regular APNs).
   * Android posts the same FCM token here AND to /push/register so
   * inbound-call wake can dispatch at high priority.
   */
  /**
   * Round 5 / Security S3 — response now carries the freshly-minted
   * per-device wake key. Client persists it in keychain and uses it
   * to HMAC-verify every inbound VoIP wake. Replay/forge attempts
   * fail signature check and are dropped before the user's phone
   * rings. Rotates on every registration call.
   */
  @Post('register-voip')
  async registerVoip(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: RegisterTokenDto,
  ): Promise<{ok: true; wakeKeyB64: string}> {
    const {wakeKeyB64} = await this.push.registerVoipToken({
      userId:    caller.claims.sub,
      deviceId:  caller.claims.deviceId,
      platform:  dto.platform,
      token:     dto.token,
      updatedAt: Date.now(),
      // Audit P0-N2 — JTI binding so revoked sessions cascade to
      // push-token cleanup within one GC tick.
    }, {jti: caller.claims.jti});
    return {ok: true, wakeKeyB64};
  }

  @Delete('register-voip')
  async unregisterVoip(@CurrentCaller() caller: CallerContext): Promise<{ok: true}> {
    await this.push.unregisterVoipToken(caller.claims.sub, caller.claims.deviceId);
    return {ok: true};
  }

  /**
   * B-239 — self-scoped push-token health probe. Lets a device (or a tester
   * signed in as the user) confirm its ring/data tokens actually reached the
   * server — the "silent ring blackout" class. Presence metadata only; the
   * token material never leaves the service. Self-scoped by design (see
   * PushService.tokenHealth for why a cross-user variant is refused).
   */
  @Get('token-health')
  async tokenHealth(@CurrentCaller() caller: CallerContext): Promise<{
    data: Array<{deviceId: string; platform: PushPlatform; ageMs: number}>;
    voip: Array<{deviceId: string; platform: PushPlatform; ageMs: number}>;
    fcmReady: boolean;
    apnsConfigured: boolean;
  }> {
    return this.push.tokenHealth(caller.claims.sub);
  }
}
