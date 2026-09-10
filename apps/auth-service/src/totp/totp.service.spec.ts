import {Test, TestingModule}  from '@nestjs/testing';
import {NotFoundException, BadRequestException} from '@nestjs/common';
import {TotpService}       from './totp.service';
import {DatabaseService}   from '../database/database.service';
import {AuditService}      from '../kafka/audit.service';
import {TotpCryptoService} from '../common/services/totp-crypto.service';
import {AuthService}       from '../auth/auth.service';
import {RedisService}      from '../redis/redis.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';

const mockDb     = {q: jest.fn(), qOne: jest.fn()};
const mockAudit  = {emit: jest.fn()};
const mockCrypto = {
  generateSecret:   jest.fn(),
  encryptSecret:    jest.fn(),
  decryptSecret:    jest.fn(),
  verifyCode:       jest.fn(),
  generateBackupCodes: jest.fn(),
  hashBackupCode:   jest.fn(),
};
const mockAuth = {issueSession: jest.fn()};
const mockRedis = {
  isTotpLocked:      jest.fn(),
  incrTotpFailures:  jest.fn(),
  lockTotp:          jest.fn(),
  clearTotpFailures: jest.fn(),
  claimTotpCounter:  jest.fn(),
};

const FAKE_USER = {
  id: 'u-1', email: 'a@b.com', display_name: 'A',
  role: 'individual', subscription_tier: 'lite', phone_e164: null,
};

describe('TotpService', () => {
  let service: TotpService;

  beforeEach(async () => {
    // resetAllMocks clears both call history AND mockReturnValueOnce queues,
    // preventing stale Once values leaking across tests.
    jest.resetAllMocks();
    mockAudit.emit.mockResolvedValue(undefined);
    mockDb.q.mockResolvedValue([]);
    mockDb.qOne.mockResolvedValue(null);
    mockCrypto.generateSecret.mockReturnValue({secret: 'BASE32SECRET', uri: 'otpauth://totp/...'});
    mockCrypto.encryptSecret.mockReturnValue(Buffer.from('enc'));
    mockCrypto.decryptSecret.mockReturnValue('DECRYPTED_SECRET');
    mockCrypto.verifyCode.mockReturnValue(null);            // default: fail — tests override with a delta
    mockCrypto.generateBackupCodes.mockReturnValue({plain: ['A1B2C3D4','E5F6G7H8'], hashes: ['h1','h2']});
    mockCrypto.hashBackupCode.mockReturnValue('backup-hash');
    mockAuth.issueSession.mockResolvedValue({accessToken:'tok', refreshToken:'ref', expiresIn:900});
    mockRedis.isTotpLocked.mockResolvedValue(false);        // default: not locked
    mockRedis.incrTotpFailures.mockResolvedValue(1);        // default: under threshold
    mockRedis.lockTotp.mockResolvedValue(undefined);
    mockRedis.clearTotpFailures.mockResolvedValue(undefined);
    // SEC-02 — default: this (user, 30s-step) pair has not been spent yet.
    // Tests that assert replay rejection override it with false.
    mockRedis.claimTotpCounter.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TotpService,
        {provide: DatabaseService,   useValue: mockDb},
        {provide: AuditService,      useValue: mockAudit},
        {provide: TotpCryptoService, useValue: mockCrypto},
        {provide: AuthService,       useValue: mockAuth},
        {provide: RedisService,      useValue: mockRedis},
        TotpChallengeService,   // real — the verify core under test now lives here
      ],
    }).compile();
    service = module.get(TotpService);
  });

  // ── setup ──────────────────────────────────────────────────────────────────
  describe('setup', () => {
    it('throws NotFoundException when user not found', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.setup('u-1', 'dev-1', '1.1.1.1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns uri and backupCodes on success', async () => {
      mockDb.qOne.mockResolvedValueOnce({email: 'a@b.com'});
      const result = await service.setup('u-1', 'dev-1', '1.1.1.1');
      expect(result.uri).toBe('otpauth://totp/...');
      expect(result.backupCodes).toEqual(['A1B2C3D4', 'E5F6G7H8']);
    });

    it('upserts totp secret (ON CONFLICT UPDATE)', async () => {
      mockDb.qOne.mockResolvedValueOnce({email: 'a@b.com'});
      await service.setup('u-1', 'dev-1', '1.1.1.1');
      const upsertCall = mockDb.q.mock.calls.find(
        c => String(c[0]).includes('auth_totp_secrets') && String(c[0]).includes('ON CONFLICT'),
      );
      expect(upsertCall).toBeDefined();
    });

    it('deletes old backup codes before inserting new ones', async () => {
      mockDb.qOne.mockResolvedValueOnce({email: 'a@b.com'});
      await service.setup('u-1', 'dev-1', '1.1.1.1');
      const deleteCall = mockDb.q.mock.calls.find(
        c => String(c[0]).includes('DELETE FROM') && String(c[0]).includes('auth_totp_backup_codes'),
      );
      expect(deleteCall).toBeDefined();
    });

    it('emits auth.totp.setup audit success event', async () => {
      mockDb.qOne.mockResolvedValueOnce({email: 'a@b.com'});
      await service.setup('u-1', 'dev-1', '1.1.1.1');
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.totp.setup', outcome: 'success'}),
      );
    });
  });

  // ── verify ─────────────────────────────────────────────────────────────────
  //
  // Audit Rev2 SEC-02 — `verify` now takes the userId as its FIRST ARGUMENT,
  // supplied by the controller from the verified access token. It is no longer
  // a DTO field, because a body-supplied account id on an unguarded route was
  // the bug. `verifyCode` likewise returns the matched step DELTA (0 is a
  // valid, falsy result) instead of a boolean, so a code can be spent once.
  describe('verify', () => {
    const USER_ID = 'u-1';
    const dto = {code:'123456', deviceId:'d-1', platform:'ios'};
    const row  = {secret_encrypted: Buffer.from('enc'), verified_at: null};

    it('throws BadRequestException when totp not set up', async () => {
      mockDb.qOne.mockResolvedValueOnce(FAKE_USER).mockResolvedValueOnce(null);   // account ok, no seed
      await expect(service.verify(USER_ID, dto as any, '1.1.1.1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException on invalid 6-digit TOTP code', async () => {
      // verifyCode defaults to null (set in beforeEach) — no override needed
      mockDb.qOne.mockResolvedValueOnce(FAKE_USER).mockResolvedValueOnce(row);
      await expect(service.verify(USER_ID, dto as any, '1.1.1.1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('issues tokens on valid TOTP code', async () => {
      mockCrypto.verifyCode.mockReturnValue(0);      // delta 0 = current step
      mockDb.qOne
        .mockResolvedValueOnce(FAKE_USER)
        .mockResolvedValueOnce(row);
      const result = await service.verify(USER_ID, dto as any, '1.1.1.1');
      expect(result.accessToken).toBe('tok');
      expect(mockAuth.issueSession).toHaveBeenCalled();
    });

    it('marks verified_at on first successful verify', async () => {
      mockCrypto.verifyCode.mockReturnValue(0);
      mockDb.qOne
        .mockResolvedValueOnce(FAKE_USER)
        .mockResolvedValueOnce(row);     // verified_at = null
      await service.verify(USER_ID, dto as any, '1.1.1.1');
      const updateCall = mockDb.q.mock.calls.find(
        c => String(c[0]).includes('verified_at=now()'),
      );
      expect(updateCall).toBeDefined();
    });

    it('skips verified_at update when already verified', async () => {
      mockCrypto.verifyCode.mockReturnValue(0);
      const alreadyVerified = {...row, verified_at: new Date()};
      mockDb.qOne
        .mockResolvedValueOnce(FAKE_USER)
        .mockResolvedValueOnce(alreadyVerified);
      await service.verify(USER_ID, dto as any, '1.1.1.1');
      const updateCall = mockDb.q.mock.calls.find(
        c => String(c[0]).includes('verified_at=now()'),
      );
      expect(updateCall).toBeUndefined();
    });

    it('issues tokens on valid 8-char backup code', async () => {
      // verifyCode returns null (default) — TOTP check fails, backup code succeeds
      const backupDto = {...dto, code: 'ABCD1234'};   // 8-char
      mockDb.qOne
        .mockResolvedValueOnce(FAKE_USER)             // account loaded first
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({id: 'bc-1'});         // backup code claimed
      const result = await service.verify(USER_ID, backupDto as any, '1.1.1.1');
      expect(result.accessToken).toBe('tok');
    });

    it('marks backup code as used_at after consumption', async () => {
      const backupDto = {...dto, code: 'ABCD1234'};
      mockDb.qOne
        .mockResolvedValueOnce(FAKE_USER)
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({id: 'bc-1'});
      await service.verify(USER_ID, backupDto as any, '1.1.1.1');
      // The consume is now a single atomic UPDATE ... RETURNING issued through
      // qOne (it used to be a SELECT via qOne then an UPDATE via q — a TOCTOU
      // that let two concurrent posts of one code both win).
      const usedCall = mockDb.qOne.mock.calls.find(
        c => String(c[0]).includes('used_at=now()') && String(c[0]).includes('auth_totp_backup_codes'),
      );
      expect(usedCall).toBeDefined();
    });

    it('emits auth.totp.verify failure on wrong code', async () => {
      // verifyCode defaults to null — no override needed
      mockDb.qOne.mockResolvedValueOnce(FAKE_USER).mockResolvedValueOnce(row);
      await expect(service.verify(USER_ID, dto as any, '1.1.1.1')).rejects.toBeDefined();
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.totp.verify', outcome: 'failure'}),
      );
    });

    it('emits auth.totp.verify success on valid code', async () => {
      mockCrypto.verifyCode.mockReturnValue(0);
      mockDb.qOne
        .mockResolvedValueOnce(FAKE_USER)
        .mockResolvedValueOnce(row);
      await service.verify(USER_ID, dto as any, '1.1.1.1');
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.totp.verify', outcome: 'success'}),
      );
    });
  });
});
