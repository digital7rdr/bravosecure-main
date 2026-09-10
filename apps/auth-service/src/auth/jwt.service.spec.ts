import {Test, TestingModule} from '@nestjs/testing';
import {ConfigService}       from '@nestjs/config';
import {JwtService}          from './jwt.service';

const mockConfig = {
  get: jest.fn((key: string) => {
    const map: Record<string, string> = {
      'jwt.accessSecret': 'test-access-secret-32chars-xxxxxxxx',
      'jwt.actionSecret': 'test-action-secret-32chars-xxxxxxxx',
      'jwt.accessTtl':    '15m',
    };
    return map[key] ?? '';
  }),
};

describe('JwtService', () => {
  let service: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtService,
        {provide: ConfigService, useValue: mockConfig},
      ],
    }).compile();
    service = module.get(JwtService);
  });

  // ── signAccessToken ───────────────────────────────────────────────────────
  describe('signAccessToken', () => {
    it('returns accessToken and jti', async () => {
      const {accessToken, jti} = await service.signAccessToken({
        sub: 'user-1', deviceId: 'dev-1', role: 'individual',
      });
      expect(typeof accessToken).toBe('string');
      expect(accessToken.split('.').length).toBe(3);  // valid JWT
      expect(typeof jti).toBe('string');
      expect(jti.length).toBeGreaterThan(0);
    });

    it('generates a unique jti on each call', async () => {
      const r1 = await service.signAccessToken({sub:'u', deviceId:'d', role:'r'});
      const r2 = await service.signAccessToken({sub:'u', deviceId:'d', role:'r'});
      expect(r1.jti).not.toBe(r2.jti);
    });
  });

  // ── verifyAccessToken ─────────────────────────────────────────────────────
  describe('verifyAccessToken', () => {
    it('returns claims for a valid token', async () => {
      const {accessToken} = await service.signAccessToken({
        sub: 'user-99', deviceId: 'device-x', role: 'admin',
      });
      const claims = await service.verifyAccessToken(accessToken);
      expect(claims.sub).toBe('user-99');
      expect(claims.deviceId).toBe('device-x');
      expect(claims.role).toBe('admin');
      expect(claims.jti).toBeTruthy();
    });

    it('throws on a tampered token', async () => {
      const {accessToken} = await service.signAccessToken({sub:'u', deviceId:'d', role:'r'});
      const tampered = accessToken.slice(0, -4) + 'XXXX';
      await expect(service.verifyAccessToken(tampered)).rejects.toThrow();
    });

    it('throws when token is signed with wrong secret', async () => {
      const wrongSecretService = new JwtService({
        get: (k: string) => {
          if (k === 'jwt.accessSecret') return 'completely-different-secret-xxxxxxx';
          if (k === 'jwt.accessTtl')    return '15m';
          if (k === 'jwt.actionSecret') return 'completely-different-action-xxxxxxx';
          return 'fallback';
        },
      } as any);
      const {accessToken} = await wrongSecretService.signAccessToken({sub:'u', deviceId:'d', role:'r'});
      await expect(service.verifyAccessToken(accessToken)).rejects.toThrow();
    });
  });

  // ── signActionToken ───────────────────────────────────────────────────────
  describe('signActionToken', () => {
    it('returns actionToken and jti', async () => {
      const {actionToken, jti} = await service.signActionToken({
        sub: 'user-1', deviceId: 'dev-1', purpose: 'high_value_transfer',
      });
      expect(actionToken.split('.').length).toBe(3);
      expect(typeof jti).toBe('string');
    });
  });

  // ── newRefreshToken ───────────────────────────────────────────────────────
  describe('newRefreshToken', () => {
    it('returns a base64url token and SHA-256 hash', () => {
      const {token, hash} = service.newRefreshToken();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(40);   // 48 bytes base64url
      expect(hash).toMatch(/^[0-9a-f]{64}$/);     // SHA-256 hex
    });

    it('generates unique tokens on each call', () => {
      const {token: t1} = service.newRefreshToken();
      const {token: t2} = service.newRefreshToken();
      expect(t1).not.toBe(t2);
    });
  });

  // ── refreshTokenHash ─────────────────────────────────────────────────────
  describe('refreshTokenHash', () => {
    it('returns same hash for same token', () => {
      const token = 'some-refresh-token-string';
      expect(service.refreshTokenHash(token)).toBe(service.refreshTokenHash(token));
    });

    it('returns different hash for different tokens', () => {
      expect(service.refreshTokenHash('token-a')).not.toBe(service.refreshTokenHash('token-b'));
    });

    it('matches the hash produced by newRefreshToken', () => {
      const {token, hash} = service.newRefreshToken();
      expect(service.refreshTokenHash(token)).toBe(hash);
    });
  });

  // ── ttlToSeconds ─────────────────────────────────────────────────────────
  describe('ttlToSeconds', () => {
    it.each([
      ['15m', 900],
      ['1h',  3600],
      ['30d', 2_592_000],
      ['60s', 60],
    ])('converts %s → %d seconds', (spec, expected) => {
      expect(service.ttlToSeconds(spec)).toBe(expected);
    });

    it('throws on invalid TTL spec', () => {
      expect(() => service.ttlToSeconds('bad')).toThrow();
    });
  });
});
