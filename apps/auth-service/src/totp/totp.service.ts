import {Injectable, NotFoundException} from '@nestjs/common';
import {DatabaseService}     from '../database/database.service';
import {AuditService}        from '../kafka/audit.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';
import {AuthService}         from '../auth/auth.service';
import type {TotpVerifyDto}  from './dto/totp-verify.dto';

import type {UserRow} from '../auth/auth.service';

@Injectable()
export class TotpService {
  constructor(
    private readonly db:          DatabaseService,
    private readonly audit:       AuditService,
    private readonly challenge:   TotpChallengeService,
    private readonly authService: AuthService,
  ) {}

  // ── Setup — generate secret, encrypt, persist, return QR + backup codes ──
  // Behind the access-token guard, so a caller who already holds a verified
  // seed can deliberately rotate it. The enrolment core is shared with the
  // login path (TotpChallengeService) — keep the two from drifting.
  async setup(userId: string, deviceId: string, ip: string) {
    const user = await this.db.qOne<{email:string}>(
      `SELECT email FROM public.users WHERE id=$1`, [userId]);
    if (!user) throw new NotFoundException('user_not_found');
    const {uri, backupCodes} = await this.challenge.enrol(userId, user.email, deviceId, ip);
    return {uri, backupCodes};
  }

  // ── Verify — TOTP code or backup code → tokens ───────────────────────────
  //
  // Audit Rev2 SEC-02 — `userId` is now a PARAMETER taken from the verified
  // access token by the controller, NOT a field on the DTO. It used to arrive
  // in the request body on an unguarded route, which meant a leaked UUID plus
  // one live code was a complete login with no password step. Keep it this
  // way: the moment the account can be named by the caller's body, the bug is
  // back, and with the guard in place it would be worse (any authenticated
  // user could mint a session for anyone else).
  async verify(userId: string, dto: TotpVerifyDto, ip: string) {
    // Load the account BEFORE the code check: TotpChallengeService.check()
    // stamps verified_at on first success, and a suspended or deleted user
    // must not be able to confirm their enrolment on the way to rejection.
    // `suspended_at IS NULL` — both SMS paths exclude suspended accounts;
    // this one once did not, so suspension did not stop a TOTP login.
    const user = await this.db.qOne<UserRow>(
      `SELECT id,email,display_name,role,subscription_tier,phone_e164
         FROM public.users WHERE id=$1 AND deleted_at IS NULL AND suspended_at IS NULL`,
      [userId],
    );
    if (!user) throw new NotFoundException('user_not_found');

    // Throws totp_invalid / totp_not_setup; lockout, replay-claim and backup
    // codes all live in the shared core.
    await this.challenge.check(userId, dto.code, dto.deviceId, ip);

    const session = await this.authService.issueSession(user, dto.deviceId, dto.platform);
    await this.audit.emit({event_type:'auth.totp.verify' as const, user_id:userId, device_id:dto.deviceId, ip, outcome:'success'});
    return {user, ...session};
  }
}
