import {Test, TestingModule} from '@nestjs/testing';
import {ConfigService}       from '@nestjs/config';
import * as OTPAuth          from 'otpauth';
import {TotpCryptoService}   from './totp-crypto.service';

const VALID_KEY = 'a'.repeat(64);   // 32-byte AES-256-GCM key as 64-char hex

const mockConfig = {
  get: jest.fn((k: string) => {
    if (k === 'totp.encryptionKey') return VALID_KEY;
    if (k === 'totp.issuer')        return 'Test Issuer';
    return undefined;
  }),
};

describe('TotpCryptoService', () => {
  let service: TotpCryptoService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TotpCryptoService,
        {provide: ConfigService, useValue: mockConfig},
      ],
    }).compile();
    service = module.get(TotpCryptoService);
  });

  // ── encKey validation ─────────────────────────────────────────────────────
  describe('encKey validation', () => {
    it('throws when TOTP_ENCRYPTION_KEY is not 64 hex chars', () => {
      const badConfig = {get: jest.fn().mockReturnValue('tooshort')};
      const svc = new TotpCryptoService(badConfig as unknown as ConfigService);
      expect(() => svc.encryptSecret('any')).toThrow('TOTP_ENCRYPTION_KEY must be 64 hex chars');
    });

    // P1-P-1 — the 64×'a' dev sentinel must be rejected in production so a
    // deploy that forgets TOTP_ENCRYPTION_KEY (or copies the placeholder)
    // cannot seal every user's TOTP secret under a publicly-known key.
    describe('production sentinel rejection', () => {
      const prevEnv = process.env['NODE_ENV'];
      afterEach(() => { process.env['NODE_ENV'] = prevEnv; });

      it('rejects the all-"a" default key in production', () => {
        process.env['NODE_ENV'] = 'production';
        const sentinelCfg = {get: jest.fn().mockReturnValue('a'.repeat(64))};
        const svc = new TotpCryptoService(sentinelCfg as unknown as ConfigService);
        expect(() => svc.encryptSecret('SECRET')).toThrow(/insecure default/);
      });

      it('accepts a real 64-hex key in production', () => {
        process.env['NODE_ENV'] = 'production';
        const realCfg = {get: jest.fn().mockReturnValue('0'.repeat(63) + '1')};
        const svc = new TotpCryptoService(realCfg as unknown as ConfigService);
        const blob = svc.encryptSecret('SECRET');
        expect(svc.decryptSecret(blob)).toBe('SECRET');
      });

      it('still allows the sentinel outside production (dev boot)', () => {
        process.env['NODE_ENV'] = 'development';
        const sentinelCfg = {get: jest.fn().mockReturnValue('a'.repeat(64))};
        const svc = new TotpCryptoService(sentinelCfg as unknown as ConfigService);
        expect(() => svc.encryptSecret('SECRET')).not.toThrow();
      });
    });
  });

  // ── encrypt / decrypt round-trip ──────────────────────────────────────────
  describe('encryptSecret / decryptSecret', () => {
    it('round-trips a TOTP secret transparently', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const blob   = service.encryptSecret(secret);
      expect(service.decryptSecret(blob)).toBe(secret);
    });

    it('produces different ciphertext on each call (random IV)', () => {
      const secret = 'SHAREDSECRET';
      const b1 = service.encryptSecret(secret);
      const b2 = service.encryptSecret(secret);
      expect(b1.equals(b2)).toBe(false);
    });

    it('ciphertext is a Buffer with IV(12) + ciphertext + tag(16)', () => {
      const blob = service.encryptSecret('TEST');
      // minimum: 12 (IV) + 1 (min payload) + 16 (tag) = 29 bytes
      expect(blob.length).toBeGreaterThanOrEqual(29);
    });
  });

  // ── generateSecret ────────────────────────────────────────────────────────
  describe('generateSecret', () => {
    it('returns a base32 secret and an otpauth URI', () => {
      const {secret, uri} = service.generateSecret('user@example.com');
      expect(secret).toMatch(/^[A-Z2-7]+=*$/i);  // base32
      expect(uri).toMatch(/^otpauth:\/\/totp\//);
    });

    it('includes the account email in the URI', () => {
      const {uri} = service.generateSecret('alice@test.com');
      expect(uri).toContain('alice');
    });
  });

  // ── verifyCode ────────────────────────────────────────────────────────────
  describe('verifyCode', () => {
    // SEC-02 — verifyCode returns the matched step DELTA (or null). It used to
    // return a boolean, which discarded the one value needed to make a code
    // single-use. Callers must test `!== null`, because delta 0 is both VALID
    // and falsy.
    it('returns null for a clearly invalid code', () => {
      const {secret} = service.generateSecret('user@test.com');
      expect(service.verifyCode(secret, '000000')).toBeNull();
    });

    it('returns the delta (0) for the current step, which is falsy but valid', () => {
      const {secret} = service.generateSecret('user@test.com');
      const totp = new OTPAuth.TOTP({
        algorithm: 'SHA1', digits: 6, period: 30,
        secret: OTPAuth.Secret.fromBase32(secret),
      });
      expect(service.verifyCode(secret, totp.generate())).toBe(0);
    });
  });

  // ── generateBackupCodes ───────────────────────────────────────────────────
  describe('generateBackupCodes', () => {
    it('generates exactly 10 backup codes', () => {
      const {plain} = service.generateBackupCodes();
      expect(plain.length).toBe(10);
    });

    it('each backup code is 8 characters from allowed charset', () => {
      const {plain} = service.generateBackupCodes();
      for (const code of plain) {
        expect(code).toMatch(/^[A-Z2-9]{8}$/);
      }
    });

    it('returns one hash per code', () => {
      const {plain, hashes} = service.generateBackupCodes();
      expect(hashes.length).toBe(plain.length);
    });

    it('generates unique codes across calls', () => {
      const {plain: a} = service.generateBackupCodes();
      const {plain: b} = service.generateBackupCodes();
      // very low probability all 10 are identical
      expect(a.join(',')).not.toBe(b.join(','));
    });
  });

  // ── hashBackupCode ────────────────────────────────────────────────────────
  describe('hashBackupCode', () => {
    it('returns a 64-char hex SHA-256 hash', () => {
      expect(service.hashBackupCode('ABCD1234')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is case-insensitive', () => {
      expect(service.hashBackupCode('abcd1234')).toBe(service.hashBackupCode('ABCD1234'));
    });

    it('trims whitespace before hashing', () => {
      expect(service.hashBackupCode('  ABCD1234  ')).toBe(service.hashBackupCode('ABCD1234'));
    });

    it('is deterministic', () => {
      const h = service.hashBackupCode('TESTCODE');
      expect(service.hashBackupCode('TESTCODE')).toBe(h);
    });
  });
});
