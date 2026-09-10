/**
 * B-696 — vault PIN verifier (VAULT_DURABILITY_DESIGN_2026-08-29 §4-§5).
 *
 * sqa.md bug register — this suite pins: B-696 (server half) and the audit-S2
 * closure: the reset flow demands the ACCOUNT PASSWORD before any OTP, the
 * reset token is single-use/purpose-bound/identity-bound, an existing
 * verifier can never be overwritten by a bare JWT, and locked responses are
 * byte-identical to plain failures.
 */
import {Test} from '@nestjs/testing';
import {BadRequestException, ForbiddenException} from '@nestjs/common';
import {VaultPinService, maskPhone, VAULT_PIN_RESET_PURPOSE} from './vault-pin.service';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {AuditService} from '../kafka/audit.service';
import {JwtService} from '../auth/jwt.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService} from '../common/services/otp.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';
import {ConfigService} from '@nestjs/config';

const mockDb = {qOne: jest.fn(), q: jest.fn()};
const mockRedis = {
  isVaultPinLocked:     jest.fn(),
  incrVaultPinFailures: jest.fn(),
  clearVaultPinFailures: jest.fn(),
  lockVaultPin:         jest.fn(),
  storeJti:             jest.fn(),
  isJtiValid:           jest.fn(),
  revokeJti:            jest.fn(),
};
const mockAudit = {emit: jest.fn()};
const mockJwt = {signActionToken: jest.fn(), verifyActionToken: jest.fn()};
const mockPassword = {hash: jest.fn(), verify: jest.fn()};
const mockOtp = {send: jest.fn(), check: jest.fn()};

const UID = 'user-1';
const DEV = 'device-1';
const IP  = '10.0.0.1';

describe('VaultPinService', () => {
  let svc: VaultPinService;

  beforeEach(async () => {
    jest.resetAllMocks();
    // Happy-path defaults (the totp.spec convention).
    mockRedis.isVaultPinLocked.mockResolvedValue(false);
    mockRedis.incrVaultPinFailures.mockResolvedValue(1);
    mockRedis.clearVaultPinFailures.mockResolvedValue(undefined);
    mockRedis.lockVaultPin.mockResolvedValue(undefined);
    mockRedis.storeJti.mockResolvedValue(undefined);
    mockRedis.isJtiValid.mockResolvedValue(true);
    mockRedis.revokeJti.mockResolvedValue(undefined);
    mockAudit.emit.mockResolvedValue(undefined);
    mockPassword.hash.mockResolvedValue('$argon2id$new-hash');
    mockPassword.verify.mockResolvedValue(true);
    mockOtp.send.mockResolvedValue(undefined);
    mockOtp.check.mockResolvedValue(true);
    mockDb.q.mockResolvedValue([]);
    mockDb.qOne.mockResolvedValue(null);

    const module = await Test.createTestingModule({
      providers: [
        VaultPinService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: RedisService,    useValue: mockRedis},
        {provide: AuditService,    useValue: mockAudit},
        {provide: JwtService,      useValue: mockJwt},
        {provide: PasswordService, useValue: mockPassword},
        {provide: OtpService,      useValue: mockOtp},
        {provide: TotpChallengeService, useValue: {status: jest.fn().mockResolvedValue('verified'), check: jest.fn()}},
        {provide: ConfigService,   useValue: {get: jest.fn().mockReturnValue(undefined)}},
      ],
    }).compile();
    svc = module.get(VaultPinService);
  });

  describe('status', () => {
    it('reports absence and presence', async () => {
      expect(await svc.status(UID)).toEqual({exists: false});
      mockDb.qOne.mockResolvedValueOnce({user_id: UID});
      expect(await svc.status(UID)).toEqual({exists: true});
    });
  });

  describe('set', () => {
    it('first set needs no currentPin, hashes with the house hasher, upserts', async () => {
      const out = await svc.set({pin: '123456'}, UID, DEV, IP);
      expect(out).toEqual({ok: true});
      expect(mockPassword.hash).toHaveBeenCalledWith('123456');
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO public\.vault_pins[\s\S]*ON CONFLICT \(user_id\) DO UPDATE/),
        [UID, '$argon2id$new-hash'],
      );
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.vault_pin.set', outcome: 'success', detail: 'first_set'}),
      );
    });

    it('S2 — a bare JWT can NEVER replace an existing verifier (currentPin required)', async () => {
      mockDb.qOne.mockResolvedValueOnce({verifier: '$argon2id$old'});
      await expect(svc.set({pin: '654321'}, UID, DEV, IP)).rejects.toThrow(BadRequestException);
      expect(mockDb.q).not.toHaveBeenCalled();
    });

    it('replace with the WRONG currentPin fails uniformly and burns an attempt', async () => {
      mockDb.qOne.mockResolvedValueOnce({verifier: '$argon2id$old'});
      mockPassword.verify.mockResolvedValueOnce(false);
      await expect(svc.set({pin: '654321', currentPin: '000000'}, UID, DEV, IP))
        .rejects.toThrow('pin_invalid');
      expect(mockRedis.incrVaultPinFailures).toHaveBeenCalledWith(UID);
      expect(mockDb.q).not.toHaveBeenCalled();
    });

    it('replace with the RIGHT currentPin verifies against the stored PHC then upserts', async () => {
      mockDb.qOne.mockResolvedValueOnce({verifier: '$argon2id$old'});
      await svc.set({pin: '654321', currentPin: '123456'}, UID, DEV, IP);
      expect(mockPassword.verify).toHaveBeenCalledWith('$argon2id$old', '123456');
      expect(mockDb.q).toHaveBeenCalled();
      expect(mockRedis.clearVaultPinFailures).toHaveBeenCalledWith(UID);
    });
  });

  describe('verify', () => {
    it('ok clears the failure budget', async () => {
      mockDb.qOne.mockResolvedValueOnce({verifier: '$argon2id$old'});
      expect(await svc.verify({pin: '123456'}, UID, DEV, IP)).toEqual({ok: true});
      expect(mockRedis.clearVaultPinFailures).toHaveBeenCalledWith(UID);
    });

    it('wrong pin → uniform pin_invalid + counter', async () => {
      mockDb.qOne.mockResolvedValueOnce({verifier: '$argon2id$old'});
      mockPassword.verify.mockResolvedValueOnce(false);
      await expect(svc.verify({pin: '999999'}, UID, DEV, IP)).rejects.toThrow('pin_invalid');
      expect(mockRedis.incrVaultPinFailures).toHaveBeenCalledWith(UID);
    });

    it('no verifier row → vault_pin_not_set (routes the client to fresh setup)', async () => {
      await expect(svc.verify({pin: '123456'}, UID, DEV, IP)).rejects.toThrow('vault_pin_not_set');
    });

    it('locked → byte-identical pin_invalid, and the hasher is never consulted', async () => {
      mockRedis.isVaultPinLocked.mockResolvedValueOnce(true);
      await expect(svc.verify({pin: '123456'}, UID, DEV, IP)).rejects.toThrow('pin_invalid');
      expect(mockPassword.verify).not.toHaveBeenCalled();
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({outcome: 'failure', detail: 'locked'}),
      );
    });

    it('the 10th failure locks for 15 minutes', async () => {
      mockDb.qOne.mockResolvedValueOnce({verifier: '$argon2id$old'});
      mockPassword.verify.mockResolvedValueOnce(false);
      mockRedis.incrVaultPinFailures.mockResolvedValueOnce(10);
      await expect(svc.verify({pin: '999999'}, UID, DEV, IP)).rejects.toThrow('pin_invalid');
      expect(mockRedis.lockVaultPin).toHaveBeenCalledWith(UID, 900);
    });
  });

  describe('reset — the S2 closure', () => {
    const userRow = {phone_e164: '+8801812345678', password_hash: '$argon2id$pw'};

    it('request: the ACCOUNT PASSWORD gates the OTP send', async () => {
      mockDb.qOne.mockResolvedValueOnce(userRow);
      mockPassword.verify.mockResolvedValueOnce(false);
      await expect(svc.resetRequest({password: 'wrong'}, UID, DEV, IP)).rejects.toThrow('reset_denied');
      expect(mockOtp.send).not.toHaveBeenCalled();
      expect(mockRedis.incrVaultPinFailures).toHaveBeenCalledWith(UID);
    });

    it('request: right password sends the OTP to the ACCOUNT phone and masks it', async () => {
      mockDb.qOne.mockResolvedValueOnce(userRow);
      const out = await svc.resetRequest({password: 'correct'}, UID, DEV, IP);
      expect(mockPassword.verify).toHaveBeenCalledWith('$argon2id$pw', 'correct');
      expect(mockOtp.send).toHaveBeenCalledWith('+8801812345678', '');
      expect(out.maskedPhone).not.toContain('12345');
      expect(out.maskedPhone!.startsWith('+8801')).toBe(true);
    });

    it('request: no phone on file → reset_unavailable, nothing sent', async () => {
      mockDb.qOne.mockResolvedValueOnce({phone_e164: null, password_hash: '$argon2id$pw'});
      await expect(svc.resetRequest({password: 'correct'}, UID, DEV, IP)).rejects.toThrow('reset_unavailable');
      expect(mockOtp.send).not.toHaveBeenCalled();
    });

    it('request: locked lane answers reset_denied — same bytes as a wrong password', async () => {
      mockRedis.isVaultPinLocked.mockResolvedValueOnce(true);
      await expect(svc.resetRequest({password: 'correct'}, UID, DEV, IP)).rejects.toThrow('reset_denied');
      expect(mockPassword.verify).not.toHaveBeenCalled();
    });

    it('verify: a wrong OTP is refused and counted', async () => {
      mockDb.qOne.mockResolvedValueOnce({phone_e164: '+8801812345678'});
      mockOtp.check.mockResolvedValueOnce(false);
      await expect(svc.resetVerify({code: '000000'}, UID, DEV, IP)).rejects.toThrow('reset_denied');
      expect(mockJwt.signActionToken).not.toHaveBeenCalled();
    });

    it('verify: a right OTP mints a purpose-bound single-use token', async () => {
      mockDb.qOne.mockResolvedValueOnce({phone_e164: '+8801812345678'});
      mockJwt.signActionToken.mockResolvedValueOnce({actionToken: 'tok', jti: 'jti-1'});
      const out = await svc.resetVerify({code: '123456'}, UID, DEV, IP);
      expect(mockJwt.signActionToken).toHaveBeenCalledWith({sub: UID, deviceId: DEV, purpose: VAULT_PIN_RESET_PURPOSE});
      expect(mockRedis.storeJti).toHaveBeenCalledWith('jti-1', 300);
      expect(out).toEqual({resetToken: 'tok', expiresIn: 300});
    });

    const goodClaims = {sub: UID, deviceId: DEV, purpose: VAULT_PIN_RESET_PURPOSE, jti: 'jti-1'};

    it('complete: happy path burns the jti BEFORE the upsert', async () => {
      mockJwt.verifyActionToken.mockResolvedValueOnce(goodClaims);
      const order: string[] = [];
      mockRedis.revokeJti.mockImplementationOnce(async () => { order.push('revoke'); });
      mockDb.q.mockImplementationOnce(async () => { order.push('upsert'); return []; });
      const out = await svc.resetComplete({resetToken: 'tok', pin: '777777'}, UID, DEV, IP);
      expect(out).toEqual({ok: true});
      expect(order).toEqual(['revoke', 'upsert']);
      expect(mockRedis.clearVaultPinFailures).toHaveBeenCalledWith(UID);
    });

    it.each([
      ['forged/expired token', () => mockJwt.verifyActionToken.mockRejectedValueOnce(new Error('bad'))],
      ['wrong purpose',        () => mockJwt.verifyActionToken.mockResolvedValueOnce({...goodClaims, purpose: 'vault-access'})],
      ['wrong subject',        () => mockJwt.verifyActionToken.mockResolvedValueOnce({...goodClaims, sub: 'someone-else'})],
      ['wrong device',         () => mockJwt.verifyActionToken.mockResolvedValueOnce({...goodClaims, deviceId: 'other-device'})],
      ['spent jti',            () => { mockJwt.verifyActionToken.mockResolvedValueOnce(goodClaims); mockRedis.isJtiValid.mockResolvedValueOnce(false); }],
    ])('complete: %s is refused with no verifier write', async (_name, arm) => {
      arm();
      await expect(svc.resetComplete({resetToken: 'tok', pin: '777777'}, UID, DEV, IP))
        .rejects.toThrow('reset_denied');
      expect(mockDb.q).not.toHaveBeenCalled();
    });
  });
});

describe('maskPhone', () => {
  it('keeps the prefix and last digits only', () => {
    expect(maskPhone('+8801812345678')).toBe('+8801••••••678');
    expect(maskPhone('+8801812345678')).not.toContain('12345');
  });
});
