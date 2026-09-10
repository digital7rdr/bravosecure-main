import {Injectable, BadRequestException} from '@nestjs/common';
import {DatabaseService}   from '../../database/database.service';
import {AuditService}      from '../../kafka/audit.service';
import {RedisService}      from '../../redis/redis.service';
import {TotpCryptoService} from './totp-crypto.service';

/**
 * TOTP as a second factor — the code-check core shared by BOTH surfaces:
 *
 *   • /auth/login → /auth/verify   (AUTH_SECOND_FACTOR=totp; no SMS provider)
 *   • /totp/setup → /totp/verify   (the pre-existing step-up route)
 *
 * WHY A SEPARATE SERVICE
 * TotpService already had a correct verify core — encrypted seed, RFC 6238
 * §5.2 replay protection by claiming the 30s step, Redis lockout, backup
 * codes — but it depends on AuthService for issueSession, and AuthService
 * now needs the same core for login. Sharing it through TotpService would be
 * an AuthService ↔ TotpService cycle. So the core lives here, depends on
 * nothing above the data layer, and BOTH callers issue their own session.
 *
 * CONTRACT — callers validate the ACCOUNT before calling check():
 * `verified_at` is stamped inside check() on first success, and the audit
 * finding on TotpService.verify was that a suspended or deleted user must
 * not be able to mark their enrolment confirmed on the way to being
 * rejected. Load the user (deleted_at IS NULL AND suspended_at IS NULL)
 * first; only then call check().
 */
export interface TotpEnrolment {
  /** otpauth:// URI — render as a QR for authenticator apps. */
  uri:         string;
  /** Base32 seed for manual entry when the QR can't be scanned. */
  secret:      string;
  /** One-time recovery codes. Shown exactly once; only hashes are stored. */
  backupCodes: string[];
}

export type TotpStatus = 'none' | 'pending' | 'verified';

@Injectable()
export class TotpChallengeService {
  // RFC 6238 §5.2 throttling — 10 wrong codes per 15-min window → 15-min lock.
  // Backup codes count too: there are only ~10, so a brute-forcer who
  // exhausts the TOTP space must not be able to pivot to unlimited guessing.
  static readonly LOCKOUT_THRESHOLD = 10;
  static readonly LOCKOUT_SECONDS   = 15 * 60;

  constructor(
    private readonly db:         DatabaseService,
    private readonly audit:      AuditService,
    private readonly redis:      RedisService,
    private readonly totpCrypto: TotpCryptoService,
  ) {}

  async status(userId: string): Promise<TotpStatus> {
    const row = await this.db.qOne<{verified_at: Date | null}>(
      `SELECT verified_at FROM public.auth_totp_secrets WHERE user_id=$1`, [userId]);
    if (!row)             return 'none';
    if (!row.verified_at) return 'pending';
    return 'verified';
  }

  /**
   * Generate + persist a fresh (unverified) seed and a new set of backup
   * codes. Re-running replaces both, which is the intended "start enrolment
   * over" behaviour — and is why callers must NEVER call this for a user who
   * already has a VERIFIED seed unless the request is itself authenticated
   * by that seed (the /totp/setup route is behind the access-token guard;
   * the login path only enrols when status() !== 'verified').
   */
  async enrol(userId: string, account: string, deviceId: string | null, ip: string): Promise<TotpEnrolment> {
    const {secret, uri}   = this.totpCrypto.generateSecret(account);
    const encrypted       = this.totpCrypto.encryptSecret(secret);
    const {plain, hashes} = this.totpCrypto.generateBackupCodes();

    await this.db.q(
      `INSERT INTO public.auth_totp_secrets (user_id,secret_encrypted)
       VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_encrypted=EXCLUDED.secret_encrypted, verified_at=NULL`,
      [userId, encrypted],
    );
    await this.db.q(`DELETE FROM public.auth_totp_backup_codes WHERE user_id=$1`, [userId]);
    for (const hash of hashes) {
      await this.db.q(
        `INSERT INTO public.auth_totp_backup_codes (id,user_id,code_hash)
         VALUES (gen_random_uuid(),$1,$2)`,
        [userId, hash],
      );
    }

    await this.audit.emit({event_type: 'auth.totp.setup', user_id: userId, device_id: deviceId, ip, outcome: 'success'});
    return {uri, secret, backupCodes: plain};
  }

  /**
   * Verify a 6-digit TOTP or an 8-char backup code. Throws `totp_invalid`
   * on failure (the same shape whether wrong, replayed, or locked — the
   * lockout state must not leak). Stamps `verified_at` on first success.
   * Returns nothing: issuing a session is the caller's job.
   */
  async check(userId: string, code: string, deviceId: string | null, ip: string): Promise<void> {
    if (await this.redis.isTotpLocked(userId)) {
      await this.audit.emit({event_type: 'auth.totp.verify', user_id: userId, device_id: deviceId, ip, outcome: 'failure', detail: 'locked'});
      throw new BadRequestException('totp_invalid');
    }

    const row = await this.db.qOne<{secret_encrypted: Buffer; verified_at: Date | null}>(
      `SELECT secret_encrypted,verified_at FROM public.auth_totp_secrets WHERE user_id=$1`,
      [userId],
    );
    if (!row) throw new BadRequestException('totp_not_setup');

    const trimmed = code.trim();
    let ok = false;

    if (/^\d{6}$/.test(trimmed)) {
      const secret = this.totpCrypto.decryptSecret(row.secret_encrypted);
      // verifyCode returns the DELTA of the matching 30s step, not a boolean:
      // with window:1 the codes for t-1, t and t+1 are all valid, so claim
      // the step the authenticator actually used. Claiming the server's own
      // step would leave the other two replayable and would permanently
      // lock out a user whose authenticator runs one step slow.
      const delta = this.totpCrypto.verifyCode(secret, trimmed);
      if (delta !== null) {
        const counter = Math.floor(Date.now() / 1000 / 30) + delta;
        ok = await this.redis.claimTotpCounter(userId, counter);
      }
    }

    if (!ok && trimmed.length === 8) {
      // Single conditional UPDATE so two concurrent posts of the same backup
      // code cannot both win (the SELECT-then-UPDATE form was a TOCTOU).
      const hash   = this.totpCrypto.hashBackupCode(trimmed);
      const backup = await this.db.qOne<{id: string}>(
        `UPDATE public.auth_totp_backup_codes SET used_at=now()
          WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL
        RETURNING id`,
        [userId, hash],
      );
      ok = !!backup;
    }

    if (!ok) {
      const failures = await this.redis.incrTotpFailures(userId);
      if (failures >= TotpChallengeService.LOCKOUT_THRESHOLD) {
        await this.redis.lockTotp(userId, TotpChallengeService.LOCKOUT_SECONDS);
      }
      await this.audit.emit({event_type: 'auth.totp.verify', user_id: userId, device_id: deviceId, ip, outcome: 'failure', detail: 'invalid_code'});
      throw new BadRequestException('totp_invalid');
    }

    // Success resets the counter so one fat-fingered code doesn't carry a
    // half-spent budget into the next session.
    await this.redis.clearTotpFailures(userId);

    if (!row.verified_at) {
      await this.db.q(`UPDATE public.auth_totp_secrets SET verified_at=now() WHERE user_id=$1`, [userId]);
    }
  }
}
