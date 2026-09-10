import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {SignJWT, jwtVerify} from 'jose';

export interface AccessClaims {
  sub:      string;
  deviceId: string;
  role:     string;
  jti:      string;
}

export interface ActionClaims {
  sub:      string;
  deviceId: string;
  purpose:  string;
  jti:      string;
}

@Injectable()
export class JwtService {
  private get accessSecret(): Uint8Array {
    return new TextEncoder().encode(this.config.get<string>('jwt.accessSecret') ?? '');
  }
  private get actionSecret(): Uint8Array {
    return new TextEncoder().encode(this.config.get<string>('jwt.actionSecret') ?? '');
  }

  constructor(private readonly config: ConfigService) {}

  /**
   * Audit fix 0.4 — `ttlSecOverride` lets callers issue a short-lived
   * access token (e.g. 5-min messenger ticket) without changing the
   * default session TTL. Same secret + audience as a normal access
   * token so the messenger-service validates it identically.
   */
  async signAccessToken(
    claims:           Omit<AccessClaims, 'jti'>,
    ttlSecOverride?:  number,
  ): Promise<{accessToken: string; jti: string}> {
    const jti = randomUUID();
    const exp = ttlSecOverride
      ? Math.floor(Date.now() / 1000) + ttlSecOverride
      : (this.config.get<string>('jwt.accessTtl') ?? '15m');
    const accessToken = await new SignJWT({device_id: claims.deviceId, role: claims.role})
      .setProtectedHeader({alg: 'HS256'})
      .setSubject(claims.sub)
      .setJti(jti)
      .setIssuedAt()
      .setIssuer('auth-service')
      .setAudience('bravo-api')
      .setExpirationTime(exp)
      .sign(this.accessSecret);
    return {accessToken, jti};
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    // Auth audit P0-A1 — pin `algorithms: ['HS256']` to match exactly
    // what `signAccessToken` emits. Same RFC 7519 §8.1 alg-confusion
    // fix that landed in messenger-service P0-3 (round 1) but never
    // applied here on the issuer side. Without it, a future swap of
    // `JWT_ACCESS_SECRET` from a symmetric secret to a PEM (Auth0 /
    // Cognito's recommended distributed-verification path) opens the
    // canonical "sign HS256 token using the public key bytes as HMAC
    // secret" forge across every authed surface in auth-service.
    const {payload} = await jwtVerify(token, this.accessSecret, {
      algorithms: ['HS256'],
      issuer:     'auth-service',
      audience:   'bravo-api',
    });
    if (!payload.jti) throw new Error('missing_jti');
    return {
      sub:      String(payload.sub),
      deviceId: String(payload['device_id'] ?? ''),
      role:     String(payload['role']),
      jti:      payload.jti,
    };
  }

  async signActionToken(claims: Omit<ActionClaims, 'jti'>): Promise<{actionToken: string; jti: string}> {
    const jti = randomUUID();
    const actionToken = await new SignJWT({device_id: claims.deviceId, purpose: claims.purpose})
      .setProtectedHeader({alg: 'HS256'})
      .setSubject(claims.sub)
      .setJti(jti)
      .setIssuedAt()
      .setIssuer('auth-service')
      .setAudience('bravo-action')
      .setExpirationTime('5m')
      .sign(this.actionSecret);
    return {actionToken, jti};
  }

  /**
   * B-696 — verify an action token THIS service minted (signActionToken).
   * Until now only messenger-service verified them (the vault MfaGuard);
   * the vault-PIN reset flow consumes its own `vault-pin-reset` token here.
   * Same alg-pinning rule as verifyAccessToken (P0-A1). jti single-use is
   * the CALLER's job (redis isJtiValid + revokeJti) — this only proves
   * signature, audience, expiry and shape.
   */
  async verifyActionToken(token: string): Promise<ActionClaims> {
    const {payload} = await jwtVerify(token, this.actionSecret, {
      algorithms: ['HS256'],
      issuer:     'auth-service',
      audience:   'bravo-action',
    });
    if (!payload.jti) throw new Error('missing_jti');
    return {
      sub:      String(payload.sub),
      deviceId: String(payload['device_id'] ?? ''),
      purpose:  String(payload['purpose'] ?? ''),
      jti:      payload.jti,
    };
  }

  ttlToSeconds(spec: string): number {
    const m = /^(\d+)\s*([smhd]?)$/.exec(spec);
    if (!m) throw new Error(`Bad TTL: ${spec}`);
    const n = Number(m[1]);
    const u = (m[2] || 's') as 's' | 'm' | 'h' | 'd';
    return n * {s: 1, m: 60, h: 3600, d: 86400}[u];
  }

  newRefreshToken(): {token: string; hash: string} {
    const token = randomBytes(48).toString('base64url');
    const hash  = createHash('sha256').update(token).digest('hex');
    return {token, hash};
  }

  refreshTokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
