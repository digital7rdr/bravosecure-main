import {Injectable, CanActivate, ExecutionContext, UnauthorizedException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import type {Request} from 'express';
import {JwtService, type ActionClaims} from '../auth/jwt.service';
import {RedisService} from '../redis/redis.service';
import type {CallerContext} from '../common/guards/jwt-http.guard';

declare module 'express' {
  interface Request {
    mfa?: ActionClaims;
  }
}

/**
 * Gates File Vault endpoints.
 *
 * Requirements BEYOND the access JWT (which the JwtHttpGuard already
 * validated on the route):
 *   - Header `X-Mfa-Proof: <action-token>` present
 *   - Action token purpose ∈ allowlist (biometric-verified, totp-verified, vault-access)
 *   - Action token `iat` fresher than `mfaMaxAgeSec` seconds
 *   - Action token `sub` + `device_id` match the caller's access token
 *
 * The middleware itself performs no biometric / OS-level check — that
 * is the client's responsibility before obtaining the action token.
 * This guard verifies the CRYPTOGRAPHIC PROOF that the step happened.
 */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly jwt:    JwtService,
    private readonly config: ConfigService,
    private readonly redis:  RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const proofHeader = (req.headers['x-mfa-proof'] ?? req.headers['X-Mfa-Proof']) as string | undefined;
    if (!proofHeader) throw new UnauthorizedException('missing_mfa_proof');

    const allowed  = this.config.get<string[]>('vault.mfaPurposes') ?? [];
    const maxAge   = this.config.get<number>('vault.mfaMaxAgeSec')  ?? 300;

    let action: ActionClaims;
    try {
      action = await this.jwt.verifyActionToken(proofHeader, {
        allowedPurposes: allowed,
        maxAgeSec:       maxAge,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'invalid_mfa_proof';
      throw new UnauthorizedException(msg);
    }

    // Cross-check against the access-token caller the route guard set.
    const caller: CallerContext | undefined = req.caller;
    if (caller && caller.claims.sub !== action.sub) {
      throw new UnauthorizedException('mfa_sub_mismatch');
    }
    if (caller && caller.claims.deviceId !== action.deviceId) {
      throw new UnauthorizedException('mfa_device_mismatch');
    }

    // Audit P3 (MFA replay) — SINGLE-USE proof. Within the freshness
    // window a captured X-Mfa-Proof header could otherwise be replayed
    // for unlimited vault URL grants. SET NX on the proof's jti with
    // TTL = its remaining freshness; a second presentation finds the
    // key and is denied, so one biometric/TOTP ceremony authorizes
    // exactly one vault operation. Fail CLOSED on Redis errors — the
    // vault MFA gate must not weaken when state is unavailable.
    const remainingSec = Math.max(1, maxAge - (Math.floor(Date.now() / 1000) - action.iat));
    let claimed: string | null;
    try {
      claimed = await this.redis.client.set(usedProofKey(action.jti), '1', 'EX', remainingSec, 'NX');
    } catch {
      throw new UnauthorizedException('mfa_proof_state_unavailable');
    }
    if (claimed !== 'OK') {
      throw new UnauthorizedException('mfa_proof_replayed');
    }

    req.mfa = action;
    return true;
  }
}

function usedProofKey(jti: string): string {
  return `vault:mfa-proof-used:${jti}`;
}
