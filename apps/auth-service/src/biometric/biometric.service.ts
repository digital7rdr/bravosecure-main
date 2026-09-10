import {Injectable, Logger, ForbiddenException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {fetchWithDeadline} from '../common/http/fetchWithDeadline';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {AuditService} from '../kafka/audit.service';
import {JwtService}   from '../auth/jwt.service';
import {effectiveTierOf} from '../common/guards/tier.guard';
import {resolveAccountKind} from '../auth/account-kind';
import type {AssertDto} from './dto/assert.dto';

/**
 * M1A — action-token purposes the messenger vault's MfaGuard accepts
 * (VAULT_MFA_PURPOSES on messenger-service). Issuance of ANY of them is
 * entitlement-gated, so a Lite client can't sidestep the tier by minting a
 * sibling purpose. Other purposes (e.g. recipient_purge for disappearing
 * messages) are NOT tier-gated and flow unchanged.
 */
const VAULT_PURPOSES = new Set(['vault-access', 'biometric-verified', 'totp-verified']);

@Injectable()
export class BiometricService {
  private readonly logger = new Logger(BiometricService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db:     DatabaseService,
    private readonly redis:  RedisService,
    private readonly audit:  AuditService,
    private readonly jwt:    JwtService,
  ) {}

  async assert(dto: AssertDto, userId: string, deviceId: string, ip: string) {
    let ok = false;
    let detail = '';

    if (this.config.get<boolean>('biometric.devBypass')) {
      this.logger.warn('BIOMETRIC_DEV_BYPASS enabled — attestation skipped');
      ok = true; detail = 'dev_bypass';
    } else if (dto.platform === 'android') {
      ({ok, detail} = await this.validateAndroid(dto.attestationToken));
    } else {
      ({ok, detail} = await this.validateIos(dto.attestationToken));
    }

    if (!ok) {
      await this.audit.emit({event_type:'auth.biometric.assert', user_id:userId, device_id:deviceId, ip, outcome:'failure', detail});
      throw new ForbiddenException({error: 'attestation_failed', detail});
    }

    // M1A tier gate — ON TOP of (never instead of) the MFA proof above.
    // Secure Cloud Vault is Pro+; org-affiliated workforce accounts (agency,
    // managed CPO) keep vault access — their tenancy, not a consumer
    // subscription, entitles them. Runs on the dev-bypass path too.
    if (VAULT_PURPOSES.has(dto.purpose)) {
      const entitled = await this.hasVaultEntitlement(userId);
      if (!entitled) {
        await this.audit.emit({event_type:'auth.biometric.assert', user_id:userId, device_id:deviceId, ip, outcome:'failure', detail:`tier_insufficient:${dto.purpose}`});
        throw new ForbiddenException('tier_insufficient');
      }
    }

    const {actionToken, jti} = await this.jwt.signActionToken({sub: userId, deviceId, purpose: dto.purpose});
    await this.redis.storeJti(jti, 300);   // 5 min, single-use (isJtiValid + revokeJti in guard)

    await this.audit.emit({event_type:'auth.biometric.assert', user_id:userId, device_id:deviceId, ip, outcome:'success', detail: dto.purpose});
    return {actionToken, expiresIn: 300, purpose: dto.purpose};
  }

  /** Cloud-vault entitlement: effective paid tier (lapse-aware) OR any
   *  org-affiliated account kind. Mirrors the client's hasCloudVault. */
  private async hasVaultEntitlement(userId: string): Promise<boolean> {
    const row = await this.db.qOne<{subscription_tier: string; pro_active_until: Date | null}>(
      `SELECT subscription_tier, pro_active_until FROM public.users
        WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (effectiveTierOf(row) !== 'lite') return true;
    const {account_kind} = await resolveAccountKind(this.db, userId);
    return account_kind !== 'individual';
  }

  private async validateAndroid(token: string): Promise<{ok:boolean; detail:string}> {
    const key     = this.config.get<string>('biometric.googleApiKey');
    const pkg     = this.config.get<string>('biometric.androidPackage') ?? 'com.bravosecure';
    if (!key) return {ok:false, detail:'GOOGLE_PLAY_INTEGRITY_KEY not configured'};

    const url  = `https://playintegrity.googleapis.com/v1/${pkg}:decodeIntegrityToken?key=${key}`;
    const json = await this.httpPost(url, JSON.stringify({integrity_token: token}), {'Content-Type':'application/json'}) as {
      tokenPayloadExternal?: {deviceIntegrity?: {deviceRecognitionVerdict?: string[]}};
    };
    const labels = json?.tokenPayloadExternal?.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    const ok     = labels.includes('MEETS_DEVICE_INTEGRITY');
    return {ok, detail: ok ? 'integrity_verified' : `verdict:${labels.join(',') || 'none'}`};
  }

  private async validateIos(token: string): Promise<{ok:boolean; detail:string}> {
    const p8 = this.config.get<string>('biometric.appleP8Key');
    if (!p8) return {ok:false, detail:'Apple p8 key not configured'};
    const dev = this.config.get<boolean>('biometric.appleDevMode');
    const url = dev
      ? 'https://api.development.devicecheck.apple.com/v1/validate_device_token'
      : 'https://api.devicecheck.apple.com/v1/validate_device_token';
    // Apple JWT signing (ES256) requires the p8 private key — wire when key provisioned.
    this.logger.warn('Apple DeviceCheck: p8 JWT signing not yet wired — update biometric.service.ts');
    return {ok:false, detail:'apple_jwt_signing_pending'};
  }

  private async httpPost(url: string, body: string, headers: Record<string,string>): Promise<unknown> {
    // Audit Rev2 API-05 — was a raw https.request with NO timeout: a stalled
    // Play Integrity socket never settled (`req.setTimeout` is only an IDLE
    // timeout and never fires against a slow-dribble / slow-loris server).
    // fetchWithDeadline bounds the whole exchange (headers AND body). Lenient
    // JSON parse preserved — a non-JSON error body yields {} and the caller's
    // verdict check then fails closed.
    const res = await fetchWithDeadline(url, {method: 'POST', headers, body, deadlineMs: 5_000});
    try { return await res.json(); } catch { return {}; }
  }
}
