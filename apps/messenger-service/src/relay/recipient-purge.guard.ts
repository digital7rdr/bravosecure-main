import {Injectable, CanActivate, ExecutionContext, UnauthorizedException} from '@nestjs/common';
import type {Request} from 'express';
import {JwtService, type ActionClaims} from '../auth/jwt.service';
import type {CallerContext} from '../common/guards/jwt-http.guard';

declare module 'express' {
  interface Request {
    purgeMfa?: ActionClaims;
  }
}

/**
 * Audit P1-T2 — gate `POST /envelopes/purge-stale-recipient` behind a
 * fresh MFA action-token, not just the access JWT.
 *
 * The purge endpoint wipes every queued envelope for the caller's
 * device. A stolen access JWT can therefore wipe the legitimate user's
 * inbox of any messages that haven't been delivered yet — a high-
 * impact denial of service on conversations the attacker can't
 * actually READ (everything inside is sealed). The original guard
 * model was JWT + a non-empty `supersededIdentity` string; neither
 * proves that the caller is the device that JUST rotated identities
 * (the only legitimate trigger).
 *
 * The MFA action token issued by auth-service for an identity rotation
 * is the right proof: it's bound to the rotation ceremony (auth-
 * service mints it after biometric/TOTP), it carries `purpose:
 * 'recipient_purge'`, and it has a tight 5-min freshness window.
 *
 * Pattern mirrors `MfaGuard` (vault) — same JwtService.verifyActionToken
 * path, same cross-check against the access token's sub/device. We
 * keep this as a SEPARATE guard so vault and purge can evolve their
 * purposes/max-ages independently.
 */
@Injectable()
export class RecipientPurgeGuard implements CanActivate {
  /** Audit P1-T2 — short window. The legitimate trigger is "I just
   * called installIdentity"; 5 min is a generous upper bound for the
   * sequence "auth-service issues token → mobile uploads new bundle
   * → mobile calls purge." Anything longer means the device sat on a
   * powerful capability for no reason. */
  private static readonly MAX_AGE_SEC = 300;
  private static readonly ALLOWED_PURPOSES = ['recipient_purge'];

  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const proofHeader = (req.headers['x-mfa-proof'] ?? req.headers['X-Mfa-Proof']) as string | undefined;
    if (!proofHeader) {
      throw new UnauthorizedException('missing_mfa_proof');
    }
    let action: ActionClaims;
    try {
      action = await this.jwt.verifyActionToken(proofHeader, {
        allowedPurposes: RecipientPurgeGuard.ALLOWED_PURPOSES,
        maxAgeSec:       RecipientPurgeGuard.MAX_AGE_SEC,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'invalid_mfa_proof';
      throw new UnauthorizedException(msg);
    }
    const caller: CallerContext | undefined = req.caller;
    if (caller && caller.claims.sub !== action.sub) {
      throw new UnauthorizedException('mfa_sub_mismatch');
    }
    if (caller && caller.claims.deviceId !== action.deviceId) {
      throw new UnauthorizedException('mfa_device_mismatch');
    }
    req.purgeMfa = action;
    return true;
  }
}
