import {Test, TestingModule} from '@nestjs/testing';
import {ForbiddenException}  from '@nestjs/common';
import {ConfigService}       from '@nestjs/config';
import {BiometricService}    from './biometric.service';
import {DatabaseService}     from '../database/database.service';
import {RedisService}        from '../redis/redis.service';
import {AuditService}        from '../kafka/audit.service';
import {JwtService}          from '../auth/jwt.service';

const mockConfig = {
  get: jest.fn((key: string) => {
    const map: Record<string, unknown> = {
      'biometric.devBypass':      false,
      'biometric.googleApiKey':   'test-key',
      'biometric.androidPackage': 'com.bravosecure',
      'biometric.appleP8Key':     '',
      'biometric.appleDevMode':   true,
    };
    return map[key];
  }),
};
// M1A — db backs the vault-purpose entitlement gate. Default: a Pro user
// (comp grant) so non-vault tests are unaffected by the tier check.
const mockDb    = {qOne: jest.fn(), q: jest.fn()};
const mockRedis = {storeJti: jest.fn(), revokeJti: jest.fn()};
const mockAudit = {emit: jest.fn()};
const mockJwt   = {signActionToken: jest.fn()};

describe('BiometricService', () => {
  let service: BiometricService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAudit.emit.mockResolvedValue(undefined);
    mockRedis.storeJti.mockResolvedValue(undefined);
    mockJwt.signActionToken.mockResolvedValue({actionToken: 'action-tok', jti: 'jti-bio'});
    mockDb.qOne.mockResolvedValue({subscription_tier: 'pro', pro_active_until: null});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BiometricService,
        {provide: ConfigService,   useValue: mockConfig},
        {provide: DatabaseService, useValue: mockDb},
        {provide: RedisService,    useValue: mockRedis},
        {provide: AuditService,    useValue: mockAudit},
        {provide: JwtService,      useValue: mockJwt},
      ],
    }).compile();
    service = module.get(BiometricService);
  });

  // ── dev bypass ────────────────────────────────────────────────────────────
  describe('dev bypass', () => {
    it('returns action token without calling external API when devBypass=true', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.devBypass' ? true : undefined,
      );
      const dto = {platform: 'android' as const, attestationToken: 'tok', purpose: 'high_value_transfer'};
      const result = await service.assert(dto, 'u-1', 'dev-1', '1.1.1.1');
      expect(result.actionToken).toBe('action-tok');
      expect(result.expiresIn).toBe(300);
    });

    it('stores jti in Redis with 300s TTL on success', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.devBypass' ? true : undefined,
      );
      const dto = {platform: 'android' as const, attestationToken: 'tok', purpose: 'export_vault'};
      await service.assert(dto, 'u-1', 'dev-1', '1.1.1.1');
      expect(mockRedis.storeJti).toHaveBeenCalledWith('jti-bio', 300);
    });

    it('emits audit success event on dev bypass', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.devBypass' ? true : undefined,
      );
      const dto = {platform: 'android' as const, attestationToken: 'tok', purpose: 'test'};
      await service.assert(dto, 'u-1', 'dev-1', '1.1.1.1');
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.biometric.assert', outcome: 'success'}),
      );
    });
  });

  // ── Android attestation ───────────────────────────────────────────────────
  describe('Android attestation', () => {
    it('throws ForbiddenException when Google API key is missing', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.googleApiKey' ? '' : undefined,
      );
      const dto = {platform: 'android' as const, attestationToken: 'tok', purpose: 'test'};
      await expect(service.assert(dto, 'u-1', 'dev-1', '1.1.1.1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('emits failure audit when attestation fails', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.googleApiKey' ? '' : undefined,
      );
      const dto = {platform: 'android' as const, attestationToken: 'tok', purpose: 'test'};
      await expect(service.assert(dto, 'u-1', 'dev-1', '1.1.1.1')).rejects.toBeDefined();
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.biometric.assert', outcome: 'failure'}),
      );
    });
  });

  // ── iOS attestation ───────────────────────────────────────────────────────
  describe('iOS attestation', () => {
    it('throws ForbiddenException when Apple p8 key is missing', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.appleP8Key' ? '' : undefined,
      );
      const dto = {platform: 'ios' as const, attestationToken: 'tok', purpose: 'test'};
      await expect(service.assert(dto, 'u-1', 'dev-1', '1.1.1.1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('emits failure audit for iOS pending p8 signing', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.appleP8Key' ? '' : undefined,
      );
      const dto = {platform: 'ios' as const, attestationToken: 'tok', purpose: 'test'};
      await expect(service.assert(dto, 'u-1', 'dev-1', '1.1.1.1')).rejects.toBeDefined();
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({outcome: 'failure'}),
      );
    });
  });

  // ── action token properties ───────────────────────────────────────────────
  describe('action token', () => {
    it('signs action token with correct purpose and userId', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.devBypass' ? true : undefined,
      );
      const dto = {platform: 'android' as const, attestationToken: 'tok', purpose: 'export_vault'};
      await service.assert(dto, 'user-99', 'dev-x', '1.1.1.1');
      expect(mockJwt.signActionToken).toHaveBeenCalledWith(
        expect.objectContaining({sub: 'user-99', purpose: 'export_vault'}),
      );
    });

    it('returns purpose in response', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.devBypass' ? true : undefined,
      );
      const dto = {platform: 'android' as const, attestationToken: 'tok', purpose: 'delete_account'};
      const result = await service.assert(dto, 'u-1', 'd-1', '1.1.1.1');
      expect(result.purpose).toBe('delete_account');
    });
  });

  // ── M1A vault-purpose tier gate ───────────────────────────────────────────
  // Secure Cloud Vault is Pro+ (matrix). The gate covers EVERY purpose the
  // messenger MfaGuard accepts, so a Lite client can't mint a sibling
  // purpose to sidestep it. It sits ON TOP of attestation — a failed
  // attestation still fails first — and runs on the dev-bypass path too.
  describe('vault-purpose tier gate (M1A)', () => {
    const bypass = () =>
      mockConfig.get.mockImplementation((key: string) =>
        key === 'biometric.devBypass' ? true : undefined,
      );
    const vaultDto = {platform: 'android' as const, attestationToken: 'tok', purpose: 'vault-access'};

    it.each(['vault-access', 'biometric-verified', 'totp-verified'])(
      'denies %s issuance to a Lite individual (tier_insufficient)',
      async purpose => {
        bypass();
        mockDb.qOne
          .mockResolvedValueOnce({subscription_tier: 'lite', pro_active_until: null}) // tier read
          .mockResolvedValueOnce(null);                                              // account-kind: no org rows
        await expect(
          service.assert({...vaultDto, purpose}, 'u-lite', 'd-1', '1.1.1.1'),
        ).rejects.toThrow(ForbiddenException);
        expect(mockJwt.signActionToken).not.toHaveBeenCalled();
        expect(mockAudit.emit).toHaveBeenCalledWith(
          expect.objectContaining({outcome: 'failure', detail: `tier_insufficient:${purpose}`}),
        );
      },
    );

    it('issues for an active Pro user', async () => {
      bypass();
      mockDb.qOne.mockResolvedValueOnce({
        subscription_tier: 'pro',
        pro_active_until: new Date(Date.now() + 86_400_000),
      });
      const res = await service.assert(vaultDto, 'u-pro', 'd-1', '1.1.1.1');
      expect(res.actionToken).toBe('action-tok');
    });

    it('treats a LAPSED Pro window as Lite and denies', async () => {
      bypass();
      mockDb.qOne
        .mockResolvedValueOnce({
          subscription_tier: 'pro',
          pro_active_until: new Date(Date.now() - 86_400_000),
        })
        .mockResolvedValueOnce(null); // account-kind: individual
      await expect(service.assert(vaultDto, 'u-lapsed', 'd-1', '1.1.1.1'))
        .rejects.toThrow(ForbiddenException);
    });

    it('issues for an Enterprise user', async () => {
      bypass();
      mockDb.qOne.mockResolvedValueOnce({subscription_tier: 'enterprise', pro_active_until: null});
      const res = await service.assert(vaultDto, 'u-ent', 'd-1', '1.1.1.1');
      expect(res.actionToken).toBe('action-tok');
    });

    it('issues for a Lite ORG-AFFILIATED account (agency/CPO tenancy entitles vault)', async () => {
      bypass();
      mockDb.qOne
        .mockResolvedValueOnce({subscription_tier: 'lite', pro_active_until: null})
        // ACCOUNT_KIND_SQL row → deriveAccountKind resolves an active cpo membership
        .mockResolvedValueOnce({
          user_role: 'individual', agent_type: null, agent_status: null,
          managed_by_org_id: null, member_role: 'cpo', member_status: 'active',
          org_user_id: 'org-1', org_name: 'Acme Sec', password_set_at: new Date(),
        });
      const res = await service.assert(vaultDto, 'u-cpo', 'd-1', '1.1.1.1');
      expect(res.actionToken).toBe('action-tok');
    });

    it('does NOT tier-gate non-vault purposes (recipient_purge flows for Lite)', async () => {
      bypass();
      mockDb.qOne.mockResolvedValueOnce({subscription_tier: 'lite', pro_active_until: null});
      const res = await service.assert(
        {...vaultDto, purpose: 'recipient_purge'}, 'u-lite', 'd-1', '1.1.1.1',
      );
      expect(res.actionToken).toBe('action-tok');
      // Tier was never even read for a non-vault purpose.
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });
  });
});
