import {Injectable, BadRequestException, ForbiddenException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {AuditService} from '../kafka/audit.service';
import {JwtService} from '../auth/jwt.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService} from '../common/services/otp.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';
import {ConfigService} from '@nestjs/config';
import type {
  SetVaultPinDto, VerifyVaultPinDto,
  VaultPinResetRequestDto, VaultPinResetVerifyDto, VaultPinResetCompleteDto,
} from './dto/vault-pin.dto';

/**
 * B-696 — server-side vault PIN VERIFIER (design doc
 * VAULT_DURABILITY_DESIGN_2026-08-29 §4-§5).
 *
 * The PIN follows the person: after a reinstall the client asks this service
 * "does a PIN exist?" and, if so, verifies the typed PIN here before
 * re-minting its LOCAL Argon2 gate from the plaintext the user just typed.
 * The server stores an argon2id hash only (PasswordService — the same
 * hasher as the account password) and can answer yes/no but never open
 * anything: no key material derives from the PIN anywhere in the system
 * (the vault file keys ride the backup master key, Phase D).
 *
 * SECURITY (audit S2 — the reset flow was ONCE a full-takeover gadget):
 *  - Reset requires the ACCOUNT PASSWORD before any OTP is sent. The OTP
 *    lands on the account's own phone, which an attacker holding the
 *    unlocked device can read — the password is the factor they lack.
 *  - Between OTP verify and the new PIN, a single-use 5-minute action token
 *    (purpose `vault-pin-reset`, jti burned via Redis) carries the proof —
 *    the exact biometric-assert/MfaGuard pattern. `vault-pin-reset` is NOT
 *    in VAULT_MFA_PURPOSES, so this token can never open the vault itself.
 *  - One Redis lockout family covers PIN verify, replace-with-currentPin
 *    AND the reset password check (10 failures / 15 min, TOTP P0-V2
 *    pattern) — a stolen JWT cannot brute-force any of the three. Locked
 *    and wrong are byte-identical to the caller (no lockout-state leak).
 *  - Deliberately NOT tier-gated: verifying a PIN grants nothing by itself;
 *    the vault entitlement gates stay where they are (M1A action-token
 *    mint + client pre-flights).
 */
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_SECONDS   = 15 * 60;
export const VAULT_PIN_RESET_PURPOSE = 'vault-pin-reset';

@Injectable()
export class VaultPinService {
  constructor(
    private readonly db:       DatabaseService,
    private readonly redis:    RedisService,
    private readonly audit:    AuditService,
    private readonly jwt:      JwtService,
    private readonly password: PasswordService,
    private readonly otp:      OtpService,
    private readonly totp:     TotpChallengeService,
    private readonly config:   ConfigService,
  ) {}

  private get secondFactor(): 'sms' | 'totp' {
    return this.config.get<'sms' | 'totp'>('auth.secondFactor') ?? 'sms';
  }

  async status(userId: string): Promise<{exists: boolean}> {
    const row = await this.db.qOne<{user_id: string}>(
      'SELECT user_id FROM public.vault_pins WHERE user_id = $1', [userId],
    );
    return {exists: row !== null};
  }

  async set(dto: SetVaultPinDto, userId: string, deviceId: string, ip: string) {
    const existing = await this.db.qOne<{verifier: string}>(
      'SELECT verifier FROM public.vault_pins WHERE user_id = $1', [userId],
    );
    if (existing) {
      // Replace: the old PIN (or a reset token, via resetComplete) is the
      // ONLY thing that authorizes overwriting a verifier. A bare JWT must
      // not — that is what lets a fresh local setup on an offline device
      // fail-safe instead of clobbering the account verifier.
      if (!dto.currentPin) {
        throw new BadRequestException('current_pin_required');
      }
      await this.gateAttempt(userId, deviceId, ip, 'auth.vault_pin.set');
      const ok = await this.password.verify(existing.verifier, dto.currentPin);
      if (!ok) {
        await this.recordFailure(userId, deviceId, ip, 'auth.vault_pin.set', 'wrong_current_pin');
        throw new ForbiddenException('pin_invalid');
      }
    }
    const verifier = await this.password.hash(dto.pin);
    await this.upsertVerifier(userId, verifier);
    await this.redis.clearVaultPinFailures(userId);
    await this.audit.emit({event_type: 'auth.vault_pin.set', user_id: userId, device_id: deviceId, ip, outcome: 'success', detail: existing ? 'replace' : 'first_set'});
    return {ok: true as const};
  }

  async verify(dto: VerifyVaultPinDto, userId: string, deviceId: string, ip: string) {
    await this.gateAttempt(userId, deviceId, ip, 'auth.vault_pin.verify');
    const row = await this.db.qOne<{verifier: string}>(
      'SELECT verifier FROM public.vault_pins WHERE user_id = $1', [userId],
    );
    if (!row) {
      // Owner-only information (GET status says the same) — a distinct code
      // here is what routes the client to fresh-setup instead of a dead end.
      throw new BadRequestException('vault_pin_not_set');
    }
    const ok = await this.password.verify(row.verifier, dto.pin);
    if (!ok) {
      await this.recordFailure(userId, deviceId, ip, 'auth.vault_pin.verify', 'wrong_pin');
      throw new ForbiddenException('pin_invalid');
    }
    await this.redis.clearVaultPinFailures(userId);
    await this.audit.emit({event_type: 'auth.vault_pin.verify', user_id: userId, device_id: deviceId, ip, outcome: 'success', detail: 'ok'});
    return {ok: true as const};
  }

  async resetRequest(dto: VaultPinResetRequestDto, userId: string, deviceId: string, ip: string) {
    await this.gateAttempt(userId, deviceId, ip, 'auth.vault_pin.reset');
    const user = await this.db.qOne<{phone_e164: string | null; password_hash: string | null}>(
      'SELECT phone_e164, password_hash FROM public.users WHERE id = $1 AND deleted_at IS NULL',
      [userId],
    );
    const ok = user?.password_hash
      ? await this.password.verify(user.password_hash, dto.password)
      : false;
    if (!ok) {
      await this.recordFailure(userId, deviceId, ip, 'auth.vault_pin.reset', 'wrong_password');
      throw new ForbiddenException('reset_denied');
    }
    if (this.secondFactor === 'totp') {
      // No SMS to send: the client shows the authenticator code box directly.
      // A user with no verified seed cannot reset this way — they never
      // finished enrolment, so there is no second factor to reset against.
      if ((await this.totp.status(userId)) !== 'verified') throw new BadRequestException('reset_unavailable');
      await this.audit.emit({event_type: 'auth.vault_pin.reset', user_id: userId, device_id: deviceId, ip, outcome: 'success', detail: 'totp_challenge'});
      return {maskedPhone: null, method: 'totp' as const};
    }
    if (!user?.phone_e164) {
      // No phone on file — nothing to send an OTP to. Distinct code so the
      // client can route to support instead of showing a code box.
      throw new BadRequestException('reset_unavailable');
    }
    await this.otp.send(user.phone_e164, '');   // send-cap enforced inside OtpService (429)
    await this.audit.emit({event_type: 'auth.vault_pin.reset', user_id: userId, device_id: deviceId, ip, outcome: 'success', detail: 'otp_sent'});
    return {maskedPhone: maskPhone(user.phone_e164), method: 'sms' as const};
  }

  async resetVerify(dto: VaultPinResetVerifyDto, userId: string, deviceId: string, ip: string) {
    await this.gateAttempt(userId, deviceId, ip, 'auth.vault_pin.reset');
    const user = await this.db.qOne<{phone_e164: string | null}>(
      'SELECT phone_e164 FROM public.users WHERE id = $1 AND deleted_at IS NULL', [userId],
    );
    let ok: boolean;
    if (this.secondFactor === 'totp') {
      // The controller's guard has already established `userId` from the
      // access token and the row above proved the account is live.
      try { await this.totp.check(userId, dto.code, deviceId, ip); ok = true; }
      catch { ok = false; }
    } else {
      if (!user?.phone_e164) {throw new BadRequestException('reset_unavailable');}
      ok = await this.otp.check(user.phone_e164, dto.code);
    }
    if (!ok) {
      await this.recordFailure(userId, deviceId, ip, 'auth.vault_pin.reset', 'wrong_otp');
      throw new ForbiddenException('reset_denied');
    }
    const {actionToken, jti} = await this.jwt.signActionToken({
      sub: userId, deviceId, purpose: VAULT_PIN_RESET_PURPOSE,
    });
    await this.redis.storeJti(jti, 300);   // 5 min, single-use (burned in resetComplete)
    await this.audit.emit({event_type: 'auth.vault_pin.reset', user_id: userId, device_id: deviceId, ip, outcome: 'success', detail: 'otp_verified'});
    return {resetToken: actionToken, expiresIn: 300};
  }

  async resetComplete(dto: VaultPinResetCompleteDto, userId: string, deviceId: string, ip: string) {
    let claims;
    try {
      claims = await this.jwt.verifyActionToken(dto.resetToken);
    } catch {
      await this.recordFailure(userId, deviceId, ip, 'auth.vault_pin.reset', 'bad_token');
      throw new ForbiddenException('reset_denied');
    }
    if (claims.purpose !== VAULT_PIN_RESET_PURPOSE || claims.sub !== userId || claims.deviceId !== deviceId) {
      await this.recordFailure(userId, deviceId, ip, 'auth.vault_pin.reset', 'token_mismatch');
      throw new ForbiddenException('reset_denied');
    }
    if (!(await this.redis.isJtiValid(claims.jti))) {
      await this.recordFailure(userId, deviceId, ip, 'auth.vault_pin.reset', 'token_spent');
      throw new ForbiddenException('reset_denied');
    }
    // Burn BEFORE acting — if the upsert fails the token is spent and the
    // user redoes the OTP. The reverse order leaves a live token behind a
    // 500, which is a replay window.
    await this.redis.revokeJti(claims.jti);
    const verifier = await this.password.hash(dto.pin);
    await this.upsertVerifier(userId, verifier);
    await this.redis.clearVaultPinFailures(userId);
    await this.audit.emit({event_type: 'auth.vault_pin.reset', user_id: userId, device_id: deviceId, ip, outcome: 'success', detail: 'completed'});
    return {ok: true as const};
  }

  private async upsertVerifier(userId: string, verifier: string): Promise<void> {
    await this.db.q(
      `INSERT INTO public.vault_pins (user_id, verifier, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET verifier = EXCLUDED.verifier, updated_at = now()`,
      [userId, verifier],
    );
  }

  /** Locked responses are byte-identical to a plain failure (no state leak). */
  private async gateAttempt(userId: string, deviceId: string, ip: string, event: 'auth.vault_pin.set' | 'auth.vault_pin.verify' | 'auth.vault_pin.reset'): Promise<void> {
    if (await this.redis.isVaultPinLocked(userId)) {
      await this.audit.emit({event_type: event, user_id: userId, device_id: deviceId, ip, outcome: 'failure', detail: 'locked'});
      throw new ForbiddenException(event === 'auth.vault_pin.reset' ? 'reset_denied' : 'pin_invalid');
    }
  }

  private async recordFailure(userId: string, deviceId: string, ip: string, event: 'auth.vault_pin.set' | 'auth.vault_pin.verify' | 'auth.vault_pin.reset', detail: string): Promise<void> {
    const failures = await this.redis.incrVaultPinFailures(userId);
    if (failures >= LOCKOUT_THRESHOLD) {
      await this.redis.lockVaultPin(userId, LOCKOUT_SECONDS);
    }
    await this.audit.emit({event_type: event, user_id: userId, device_id: deviceId, ip, outcome: 'failure', detail});
  }
}

/** `+8801812345678` → `+8801•••••678` — enough to recognize, nothing to dial. */
export function maskPhone(e164: string): string {
  if (e164.length <= 7) {return e164.replace(/\d(?=\d{2})/g, '•');}
  return e164.slice(0, 5) + '•'.repeat(e164.length - 8) + e164.slice(-3);
}
