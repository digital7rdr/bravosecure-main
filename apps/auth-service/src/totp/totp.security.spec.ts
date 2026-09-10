// ──────────────────────────────────────────────────────────────────────
// Audit Rev2 SEC-02 — "TOTP on its own logs you in".
//
// POST /auth/totp/verify carried NO guard and took `userId` from the REQUEST
// BODY, then called authService.issueSession(...) and returned real access +
// refresh tokens. Anyone holding a victim's UUID (they leak through group
// member lists, ops views and profile payloads) plus one live 6-digit code
// logged in WITHOUT EVER KNOWING THE PASSWORD. Two-factor collapsed into one
// factor six digits long.
//
// WHY THE FIX IS A GUARD AND NOT A PENDING-LOGIN TOKEN:
//   Verified 2026-08-05 — NO client has ever called this endpoint.
//   `grep -rn "auth/totp" src/ apps/ops-console/src/` returns exactly one hit,
//   and it is a DOCSTRING in vault/vaultClient.ts. ops-console's login screen
//   uses the SMS OTP (`otp` state), and VaultOTPVerifyScreen is hard-disabled
//   (VAULT_RESET_BACKEND_AVAILABLE = false). AuthService.login has no TOTP
//   branch at all — it always sends an SMS. So there is no shipped caller to
//   keep compatible, and the endpoint's own OpenAPI spec already describes it
//   as "the second half of a step-up auth flow (bearer + TOTP code)".
//   Guarding it makes the implementation match its documented contract.
//
// NOT ENOUGH ON ITS OWN: with only a guard, ANY authenticated user could still
// post someone else's userId and receive a session for that account — a
// privilege escalation strictly worse than the bug being fixed. The account
// MUST come from the verified JWT, never the body.
// ──────────────────────────────────────────────────────────────────────
import {Test, TestingModule}       from '@nestjs/testing';
import {BadRequestException}       from '@nestjs/common';
import {getMetadataStorage}        from 'class-validator';
import {TotpController}            from './totp.controller';
import {TotpService}               from './totp.service';
import {TotpVerifyDto}             from './dto/totp-verify.dto';
import {JwtAuthGuard}              from '../common/guards/jwt-auth.guard';
import {DatabaseService}           from '../database/database.service';
import {AuditService}              from '../kafka/audit.service';
import {TotpCryptoService}         from '../common/services/totp-crypto.service';
import {AuthService}               from '../auth/auth.service';
import {RedisService}              from '../redis/redis.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';

const CALLER = '11111111-1111-4111-8111-111111111111';
const VICTIM = '22222222-2222-4222-8222-222222222222';

const mockDb     = {q: jest.fn(), qOne: jest.fn()};
const mockAudit  = {emit: jest.fn()};
const mockCrypto = {
  generateSecret: jest.fn(), encryptSecret: jest.fn(), decryptSecret: jest.fn(),
  verifyCode: jest.fn(), generateBackupCodes: jest.fn(), hashBackupCode: jest.fn(),
};
const mockAuth  = {issueSession: jest.fn()};
const mockRedis = {
  isTotpLocked: jest.fn(), incrTotpFailures: jest.fn(), lockTotp: jest.fn(),
  clearTotpFailures: jest.fn(), claimTotpCounter: jest.fn(),
};

const USER_ROW = {
  id: CALLER, email: 'a@b.com', display_name: 'A',
  role: 'individual', subscription_tier: 'lite', phone_e164: null,
};

describe('SEC-02 — TOTP verify must not be a standalone login', () => {
  let service: TotpService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockAudit.emit.mockResolvedValue(undefined);
    mockDb.q.mockResolvedValue([]);
    mockDb.qOne.mockResolvedValue(null);
    mockCrypto.decryptSecret.mockReturnValue('DECRYPTED_SECRET');
    mockCrypto.verifyCode.mockReturnValue(null);
    mockCrypto.hashBackupCode.mockReturnValue('backup-hash');
    mockAuth.issueSession.mockResolvedValue({accessToken: 'tok', refreshToken: 'ref', expiresIn: 900});
    mockRedis.isTotpLocked.mockResolvedValue(false);
    mockRedis.incrTotpFailures.mockResolvedValue(1);
    mockRedis.lockTotp.mockResolvedValue(undefined);
    mockRedis.clearTotpFailures.mockResolvedValue(undefined);
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

  // ── The guard ────────────────────────────────────────────────────────────
  it('POST /auth/totp/verify is protected by JwtAuthGuard', () => {
    // Nest stores method-level @UseGuards under the '__guards__' metadata key.
    const guards = Reflect.getMetadata('__guards__', TotpController.prototype.verify) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });

  // ── The account must come from the token, not the body ───────────────────
  it('TotpVerifyDto does not accept a userId — the body cannot select an account', () => {
    const validated = getMetadataStorage()
      .getTargetValidationMetadatas(TotpVerifyDto, '', false, false)
      .map(m => m.propertyName);
    expect(validated).not.toContain('userId');
  });

  it('verify() acts on the authenticated caller, never on a body-supplied id', async () => {
    // Even if a caller smuggles a victim id through, every read/write must be
    // keyed on CALLER. This is the privilege-escalation guard.
    mockDb.qOne
      .mockResolvedValueOnce({secret_encrypted: Buffer.from('x'), verified_at: new Date()})
      .mockResolvedValueOnce(USER_ROW);
    mockCrypto.verifyCode.mockReturnValue(0);

    await service.verify(CALLER, {code: '123456', deviceId: 'd1', platform: 'ios'} as TotpVerifyDto, '1.2.3.4');

    const everyIdArg = [...mockDb.qOne.mock.calls, ...mockDb.q.mock.calls]
      .flatMap(call => (call[1] as unknown[] | undefined) ?? []);
    expect(everyIdArg).toContain(CALLER);
    expect(everyIdArg).not.toContain(VICTIM);
    expect(mockRedis.isTotpLocked).toHaveBeenCalledWith(CALLER);
  });

  // ── RFC 6238 §5.2 — a used code must be rejected ─────────────────────────
  it('rejects a replayed TOTP code (single-use per counter)', async () => {
    mockDb.qOne.mockResolvedValue({secret_encrypted: Buffer.from('x'), verified_at: new Date()});
    mockCrypto.verifyCode.mockReturnValue(0);
    // The counter claim fails => this exact counter was already spent.
    mockRedis.claimTotpCounter.mockResolvedValue(false);

    await expect(
      service.verify(CALLER, {code: '123456', deviceId: 'd1', platform: 'ios'} as TotpVerifyDto, '1.2.3.4'),
    ).rejects.toThrow(BadRequestException);
    expect(mockAuth.issueSession).not.toHaveBeenCalled();
  });

  it('claims the counter the AUTHENTICATOR used (server counter + delta), not the server clock', async () => {
    mockDb.qOne
      .mockResolvedValueOnce({secret_encrypted: Buffer.from('x'), verified_at: new Date()})
      .mockResolvedValueOnce(USER_ROW);
    // delta -1 => the user's authenticator is one 30s step behind.
    mockCrypto.verifyCode.mockReturnValue(-1);

    await service.verify(CALLER, {code: '123456', deviceId: 'd1', platform: 'ios'} as TotpVerifyDto, '1.2.3.4');

    const expected = Math.floor(Date.now() / 1000 / 30) - 1;
    expect(mockRedis.claimTotpCounter).toHaveBeenCalledWith(CALLER, expected);
  });

  // ── Backup codes: single-use must survive concurrency ────────────────────
  it('consumes a backup code with ONE atomic conditional UPDATE (no SELECT-then-UPDATE)', async () => {
    mockDb.qOne.mockImplementation((sql: string) => {
      if (/auth_totp_secrets/.test(sql)) {
        return Promise.resolve({secret_encrypted: Buffer.from('x'), verified_at: new Date()});
      }
      if (/UPDATE\s+public\.auth_totp_backup_codes/i.test(sql)) {
        return Promise.resolve({id: 'bc-1'});   // claimed
      }
      if (/FROM public\.users/.test(sql)) {return Promise.resolve(USER_ROW);}
      return Promise.resolve(null);
    });

    await service.verify(CALLER, {code: 'ABCD1234', deviceId: 'd1', platform: 'ios'} as TotpVerifyDto, '1.2.3.4');

    const sqls = [...mockDb.qOne.mock.calls, ...mockDb.q.mock.calls].map(c => String(c[0]));
    const backupSql = sqls.filter(s => /auth_totp_backup_codes/i.test(s));
    // A read-then-write pair is the TOCTOU: two concurrent posts of the same
    // code both pass the SELECT and both get a session.
    expect(backupSql.some(s => /^\s*SELECT/i.test(s))).toBe(false);
    expect(backupSql.some(s => /UPDATE[\s\S]*used_at IS NULL[\s\S]*RETURNING/i.test(s))).toBe(true);
  });

  // ── Suspension must hold on this path too ────────────────────────────────
  it('refuses to issue a session for a suspended account', async () => {
    mockDb.qOne
      .mockResolvedValueOnce({secret_encrypted: Buffer.from('x'), verified_at: new Date()})
      .mockResolvedValueOnce(null);           // user lookup excludes suspended rows
    mockCrypto.verifyCode.mockReturnValue(0);

    await expect(
      service.verify(CALLER, {code: '123456', deviceId: 'd1', platform: 'ios'} as TotpVerifyDto, '1.2.3.4'),
    ).rejects.toThrow();
    expect(mockAuth.issueSession).not.toHaveBeenCalled();

    const userSql = [...mockDb.qOne.mock.calls].map(c => String(c[0])).find(s => /FROM public\.users/.test(s));
    expect(userSql).toMatch(/suspended_at IS NULL/);
  });
});
