import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {jwtVerify} from 'jose';

/**
 * Access-token claims we consume. This is a SUBSET of what auth-service
 * signs — we only read what we need to authorize a WebSocket upgrade.
 * Keep the shape compatible; do NOT re-sign tokens here.
 */
export interface AccessClaims {
  sub:      string;
  deviceId: string;
  role:     string;
  jti:      string;
}

/**
 * Short-lived MFA-proof token minted by auth-service (biometric /
 * TOTP / vault challenges). messenger-service trusts it as "user
 * completed a fresh MFA step" — no local MFA logic here.
 */
export interface ActionClaims {
  sub:      string;
  deviceId: string;
  purpose:  string;
  jti:      string;
  iat:      number;
}

@Injectable()
export class JwtService {
  private readonly logger = new Logger(JwtService.name);

  constructor(private readonly config: ConfigService) {}

  private get accessSecret(): Uint8Array {
    const s = this.config.get<string>('jwt.accessSecret') ?? '';
    // Audit P3 (access-secret fail-open) — FAIL CLOSED, aligned with the
    // actionSecret getter below. Previously an empty secret only logged and
    // verification proceeded with a ZERO-LENGTH HMAC key — a token signed
    // with the empty string would VERIFY, so a misconfigured deploy accepted
    // attacker-minted JWTs on every HTTP route and WS upgrade. Lazy getter →
    // boot is unaffected; only a misconfigured deploy's verify paths fail
    // (which is the point).
    if (!s) {
      this.logger.error('JWT_ACCESS_SECRET is empty — refusing to verify access tokens');
      throw new Error('JWT_ACCESS_SECRET not configured');
    }
    return new TextEncoder().encode(s);
  }

  private get actionSecret(): Uint8Array {
    const s = this.config.get<string>('jwt.actionSecret') ?? '';
    // F8 action-secret-no-fail-closed — FAIL CLOSED. The File Vault MFA gate
    // (P0-A5) is only meaningful if the action secret EXISTS and is DISTINCT
    // from the access secret; otherwise a leaked session-token secret could
    // mint valid MFA proofs. Previously an empty (or equal) secret only logged
    // and the service kept serving. Now the getter throws, so MFA verification
    // DENIES instead of silently accepting. Lazy getter → boot is unaffected;
    // only a misconfigured deploy's MFA path fails (which is the point).
    if (!s) {
      this.logger.error('JWT_ACTION_SECRET is empty — refusing to verify MFA proofs');
      throw new Error('JWT_ACTION_SECRET not configured');
    }
    const access = this.config.get<string>('jwt.accessSecret') ?? '';
    if (s === access) {
      this.logger.error('JWT_ACTION_SECRET must differ from JWT_ACCESS_SECRET — refusing to verify MFA proofs');
      throw new Error('JWT_ACTION_SECRET equals JWT_ACCESS_SECRET');
    }
    return new TextEncoder().encode(s);
  }

  /**
   * Validates an access token signed by auth-service. Throws if any of:
   *  - signature invalid
   *  - issuer/audience mismatch
   *  - alg in header is not HS256 (audit P0-3 — alg-confusion defence)
   *  - expired
   *  - missing claims we require (jti, device_id, sub)
   *
   * Does NOT consult any revocation list here — the guards layer above
   * (`JwtHttpGuard`, WS handshake middleware) call `redis.isJtiValid`
   * for that. Keeping this method pure lets the WS pipe re-use the
   * same verify path without two-stage state.
   *
   * Audit P0-3 — `algorithms: ['HS256']` pin: jose defaults accept any
   * alg matching the key shape. Auth-service signs with HS256 (see
   * `apps/auth-service/src/auth/jwt.service.ts` setProtectedHeader);
   * without this allowlist, a future swap to a PEM-backed asymmetric
   * key (RS256/ES256) opens the canonical RFC 7519 §8.1 alg-confusion
   * attack where an attacker signs an HS256 token using the public key
   * bytes as the HMAC secret. Pinning here closes it permanently. To
   * rotate to a different alg, this allowlist must be updated AND a
   * staged rollout coordinated with auth-service — never silently.
   */
  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const issuer   = this.config.get<string>('jwt.issuer');
    const audience = this.config.get<string>('jwt.audience');
    const {payload} = await jwtVerify(token, this.accessSecret, {
      issuer, audience, algorithms: ['HS256'],
    });
    if (!payload.jti) throw new Error('missing_jti');
    if (!payload.sub) throw new Error('missing_sub');
    const deviceId = String(payload['device_id'] ?? '');
    if (!deviceId)   throw new Error('missing_device_id');
    return {
      sub:      String(payload.sub),
      deviceId,
      role:     String(payload['role'] ?? ''),
      jti:      payload.jti,
    };
  }

  /**
   * Validate an action-token (short-lived MFA proof). Compared to
   * access tokens we additionally require a `purpose` claim and a
   * `maxAgeSec` freshness check — "JWT still not expired" isn't
   * enough for vault access. Caller supplies the allowlist of purposes
   * it accepts + how recent the iat must be.
   */
  async verifyActionToken(token: string, opts: {
    allowedPurposes: string[];
    maxAgeSec:       number;
  }): Promise<ActionClaims> {
    const issuer   = this.config.get<string>('jwt.issuer');
    const audience = this.config.get<string>('jwt.actionAudience');
    // Audit P0-3 — pin HS256 here too. Action tokens gate File Vault
    // MFA which is an even higher-value target than the access token
    // surface, so leaving alg unrestricted would be strictly worse.
    const {payload} = await jwtVerify(token, this.actionSecret, {
      issuer, audience, algorithms: ['HS256'],
    });
    if (!payload.jti) throw new Error('missing_jti');
    if (!payload.sub) throw new Error('missing_sub');
    if (typeof payload.iat !== 'number') throw new Error('missing_iat');
    const purpose = String(payload['purpose'] ?? '');
    if (!purpose) throw new Error('missing_purpose');
    if (!opts.allowedPurposes.includes(purpose)) throw new Error('purpose_not_allowed');
    const ageSec = Math.floor(Date.now() / 1000) - payload.iat;
    if (ageSec > opts.maxAgeSec) throw new Error('mfa_proof_stale');
    const deviceId = String(payload['device_id'] ?? '');
    if (!deviceId) throw new Error('missing_device_id');
    return {
      sub:     String(payload.sub),
      deviceId,
      purpose,
      jti:     payload.jti,
      iat:     payload.iat,
    };
  }
}
