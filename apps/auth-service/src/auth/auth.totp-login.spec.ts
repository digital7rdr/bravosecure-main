import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException} from '@nestjs/common';
import {ConfigService}   from '@nestjs/config';
import {AuthService}     from './auth.service';
import {JwtService}      from './jwt.service';
import {DatabaseService} from '../database/database.service';
import {RedisService}    from '../redis/redis.service';
import {AuditService}    from '../kafka/audit.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService}      from '../common/services/otp.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';

/**
 * AUTH_SECOND_FACTOR=totp — the production login path with no SMS provider.
 *
 * What these tests pin down:
 *   • the SMS provider is never touched in totp mode;
 *   • an invalid password returns the same null-shaped 200 as SMS mode
 *     (no account enumeration), now including the new fields;
 *   • a user with no verified seed gets an enrolment payload, a user with a
 *     verified seed gets only a challenge — never a seed;
 *   • /verify is bound to the challengeId /login issued: a leaked user UUID
 *     plus a live code is NOT a login (the SEC-02 property, now on the
 *     unauthenticated route too);
 *   • wrong codes burn the challenge's attempt budget and the third one
 *     retires it;
 *   • registration creates the account up front with kyc 'pending' and
 *     verify() flips it to 'approved'; an abandoned enrolment may re-register,
 *     a completed one may not.
 */
const mockDb    = {q: jest.fn(), qOne: jest.fn()};
const mockRedis = {
  storeJti: jest.fn(), revokeJti: jest.fn(), revokeJtis: jest.fn(), isJtiValid: jest.fn(),
  markPushRevoked: jest.fn(), markPushRevokedMany: jest.fn(), clearPushRevoked: jest.fn(),
  client: {get: jest.fn()},
};
const mockAudit = {emit: jest.fn()};
const mockPw    = {hash: jest.fn(), verify: jest.fn()};
const mockOtp   = {generate: jest.fn(), hash: jest.fn(), send: jest.fn(), check: jest.fn()};
const mockJwt   = {signAccessToken: jest.fn(), newRefreshToken: jest.fn(), refreshTokenHash: jest.fn(), ttlToSeconds: jest.fn()};
const mockTotp  = {status: jest.fn(), enrol: jest.fn(), check: jest.fn()};
const CONFIG: Record<string, unknown> = {
  'auth.secondFactor': 'totp',
  'jwt.refreshTtl': '30d', 'jwt.accessTtl': '15m',
  'otp.ttlMinutes': 10, 'otp.maxAttempts': 3, 'otp.devReturnCode': false, 'otp.devBypass': false,
};
// Re-armed in beforeEach: jest.resetAllMocks() strips a jest.fn(impl)'s
// implementation, and a config that answers undefined silently falls back to
// the SMS path — every test would then pass or fail for the wrong reason.
const mockConfig = {get: jest.fn()};

const USER = {id: 'u-1', email: 'a@b.com', display_name: 'A', role: 'individual', subscription_tier: 'lite', phone_e164: '+15555550101'};
const USER_WITH_PW = {...USER, password_hash: '$argon2id$pw'};
const CHALLENGE = '11111111-1111-4111-8111-111111111111';
const ENROL = {uri: 'otpauth://totp/x', secret: 'BASE32SEED', backupCodes: ['AAAAAAAA']};
const liveChallenge = () => ({id: CHALLENGE, expires_at: new Date(Date.now() + 60_000), used_at: null, attempt_count: 0});

describe('AuthService — AUTH_SECOND_FACTOR=totp', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockConfig.get.mockImplementation((key: string) => CONFIG[key]);
    mockJwt.signAccessToken.mockResolvedValue({accessToken: 'tok', jti: 'jti-1'});
    mockJwt.newRefreshToken.mockReturnValue({token: 'ref', hash: 'ref-hash'});
    mockJwt.refreshTokenHash.mockReturnValue('hash');
    mockJwt.ttlToSeconds.mockImplementation((s: string) => (s === '15m' ? 900 : 2_592_000));
    mockDb.q.mockResolvedValue([{id: CHALLENGE}]);      // INSERT … RETURNING id for the challenge
    mockDb.qOne.mockResolvedValue(null);
    for (const fn of [mockRedis.storeJti, mockRedis.revokeJti, mockRedis.revokeJtis, mockRedis.markPushRevoked, mockRedis.markPushRevokedMany, mockRedis.clearPushRevoked]) fn.mockResolvedValue(undefined);
    mockAudit.emit.mockResolvedValue(undefined);
    mockPw.verify.mockResolvedValue(false);
    mockPw.hash.mockResolvedValue('$argon2id$new');
    mockTotp.status.mockResolvedValue('none');
    mockTotp.enrol.mockResolvedValue(ENROL);
    mockTotp.check.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: RedisService,    useValue: mockRedis},
        {provide: AuditService,    useValue: mockAudit},
        {provide: PasswordService, useValue: mockPw},
        {provide: OtpService,      useValue: mockOtp},
        {provide: JwtService,      useValue: mockJwt},
        {provide: ConfigService,   useValue: mockConfig},
        {provide: TotpChallengeService, useValue: mockTotp},
      ],
    }).compile();
    service = module.get(AuthService);
  });

  // ── login ────────────────────────────────────────────────────────────────
  describe('login', () => {
    it('wrong password → the same null shape as SMS mode; nothing enrolled, nothing sent', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER_WITH_PW);
      mockPw.verify.mockResolvedValueOnce(false);
      const out = await service.login({phoneE164: USER.phone_e164, password: 'nope'}, '1.1.1.1');
      expect(out).toEqual({userId: null, otpSentTo: null, devOtpCode: null, challengeId: null, secondFactor: null, enrol: null});
      expect(mockTotp.enrol).not.toHaveBeenCalled();
      expect(mockOtp.send).not.toHaveBeenCalled();
    });

    it('unknown account → identical null shape (no enumeration)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const out = await service.login({phoneE164: '+10000000000', password: 'x'}, '1.1.1.1');
      expect(out).toEqual({userId: null, otpSentTo: null, devOtpCode: null, challengeId: null, secondFactor: null, enrol: null});
    });

    it('no verified seed → challenge + enrolment payload; the SMS provider is never called', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER_WITH_PW);
      mockPw.verify.mockResolvedValueOnce(true);
      mockTotp.status.mockResolvedValueOnce('none');
      const out = await service.login({phoneE164: USER.phone_e164, password: 'ok'}, '1.1.1.1');
      expect(out.userId).toBe(USER.id);
      expect(out.challengeId).toBe(CHALLENGE);
      expect(out.secondFactor).toBe('totp_enrol');
      expect(out.enrol).toEqual(ENROL);
      expect(out.otpSentTo).toBeNull();
      expect(mockTotp.enrol).toHaveBeenCalledWith(USER.id, USER.email, null, '1.1.1.1');
      expect(mockOtp.send).not.toHaveBeenCalled();
      // the challenge row is opened with channel 'totp'
      const insert = mockDb.q.mock.calls.find(c => String(c[0]).includes('INSERT INTO auth_otps'));
      expect(insert?.[0]).toContain("'totp'");
    });

    it('verified seed → challenge only; a seed is NEVER handed out to a password-only caller', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER_WITH_PW);
      mockPw.verify.mockResolvedValueOnce(true);
      mockTotp.status.mockResolvedValueOnce('verified');
      const out = await service.login({phoneE164: USER.phone_e164, password: 'ok'}, '1.1.1.1');
      expect(out.secondFactor).toBe('totp');
      expect(out.enrol).toBeNull();
      expect(mockTotp.enrol).not.toHaveBeenCalled();
    });

    it('pending (unverified) seed → re-enrols so a stale, possibly-abandoned seed is replaced', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER_WITH_PW);
      mockPw.verify.mockResolvedValueOnce(true);
      mockTotp.status.mockResolvedValueOnce('pending');
      const out = await service.login({phoneE164: USER.phone_e164, password: 'ok'}, '1.1.1.1');
      expect(out.secondFactor).toBe('totp_enrol');
      expect(mockTotp.enrol).toHaveBeenCalledTimes(1);
    });
  });

  // ── verify ───────────────────────────────────────────────────────────────
  describe('verify', () => {
    const dto = {userId: USER.id, code: '123456', deviceId: 'dev-1', platform: 'android', challengeId: CHALLENGE};

    it('refuses without a challengeId — a bare UUID + live code is not a login', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER);
      await expect(service.verify({...dto, challengeId: undefined}, '1.1.1.1')).rejects.toThrow('challenge_required');
      expect(mockTotp.check).not.toHaveBeenCalled();
    });

    it('refuses a challengeId that is not this user\'s (same code as "none pending")', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER).mockResolvedValueOnce(null);
      await expect(service.verify(dto, '1.1.1.1')).rejects.toThrow('no_pending_otp');
      const sel = mockDb.qOne.mock.calls[1];
      expect(String(sel[0])).toContain("channel='totp'");
      expect(sel[1]).toEqual([CHALLENGE, USER.id]);       // bound to BOTH id and user
      expect(mockTotp.check).not.toHaveBeenCalled();
    });

    it('expired / used / exhausted challenges are rejected before the code is even checked', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER).mockResolvedValueOnce({...liveChallenge(), expires_at: new Date(Date.now() - 1)});
      await expect(service.verify(dto, '1.1.1.1')).rejects.toThrow('otp_expired');
      mockDb.qOne.mockResolvedValueOnce(USER).mockResolvedValueOnce({...liveChallenge(), used_at: new Date()});
      await expect(service.verify(dto, '1.1.1.1')).rejects.toThrow('otp_already_used');
      mockDb.qOne.mockResolvedValueOnce(USER).mockResolvedValueOnce({...liveChallenge(), attempt_count: 3});
      await expect(service.verify(dto, '1.1.1.1')).rejects.toThrow('otp_max_attempts');
      expect(mockTotp.check).not.toHaveBeenCalled();
    });

    it('valid code → challenge retired, kyc approved, session issued with device eviction', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER).mockResolvedValueOnce(liveChallenge());
      const out = await service.verify(dto, '1.1.1.1');
      expect(mockTotp.check).toHaveBeenCalledWith(USER.id, '123456', 'dev-1', '1.1.1.1');
      expect(out.accessToken).toBe('tok');
      const sqls = mockDb.q.mock.calls.map(c => String(c[0]));
      expect(sqls.some(s => s.includes('UPDATE auth_otps SET used_at=now()'))).toBe(true);
      expect(sqls.some(s => s.includes("kyc_status='approved'"))).toBe(true);
      expect(mockAudit.emit).toHaveBeenCalledWith(expect.objectContaining({event_type: 'auth.verify', outcome: 'success', detail: 'totp'}));
    });

    it('wrong code → attempt burned, attemptsLeft reported, challenge still live', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER).mockResolvedValueOnce(liveChallenge());
      mockTotp.check.mockRejectedValueOnce(new BadRequestException('totp_invalid'));
      await expect(service.verify(dto, '1.1.1.1')).rejects.toMatchObject({response: {error: 'otp_invalid', attemptsLeft: 2}});
      const bump = mockDb.q.mock.calls.find(c => String(c[0]).includes('SET attempt_count=$1 WHERE'));
      expect(bump?.[1]).toEqual([1, CHALLENGE]);
    });

    it('third wrong code retires the challenge', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER).mockResolvedValueOnce({...liveChallenge(), attempt_count: 2});
      mockTotp.check.mockRejectedValueOnce(new BadRequestException('totp_invalid'));
      await expect(service.verify(dto, '1.1.1.1')).rejects.toThrow('otp_max_attempts');
      const retire = mockDb.q.mock.calls.find(c => String(c[0]).includes('attempt_count=$1,used_at=now()'));
      expect(retire?.[1]).toEqual([3, CHALLENGE]);
    });

    it('never calls the SMS provider', async () => {
      mockDb.qOne.mockResolvedValueOnce(USER).mockResolvedValueOnce(liveChallenge());
      await service.verify(dto, '1.1.1.1');
      expect(mockOtp.check).not.toHaveBeenCalled();
    });
  });

  // ── register ─────────────────────────────────────────────────────────────
  describe('register', () => {
    const dto = {email: USER.email, password: 'pass1234', displayName: 'A', phoneE164: USER.phone_e164};

    it('new account → created with kyc pending, enrolment returned, no SMS', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(USER);   // existence check, then reload
      mockDb.q.mockResolvedValueOnce([{id: USER.id}]).mockResolvedValueOnce([{id: CHALLENGE}]);
      const out = await service.register(dto, '1.1.1.1');
      const insert = mockDb.q.mock.calls.find(c => String(c[0]).includes('INSERT INTO public.users'));
      expect(String(insert?.[0])).toContain("'pending'");
      expect(out.secondFactor).toBe('totp_enrol');
      expect(out.challengeId).toBe(CHALLENGE);
      expect(out.enrol).toEqual(ENROL);
      expect(mockOtp.send).not.toHaveBeenCalled();
    });

    it('existing account WITH a verified seed → already_exists', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: USER.id});
      mockTotp.status.mockResolvedValueOnce('verified');
      await expect(service.register(dto, '1.1.1.1')).rejects.toBeInstanceOf(ConflictException);
      expect(mockTotp.enrol).not.toHaveBeenCalled();
    });

    it('existing account that never finished enrolment → treated as start-over (password reset, new seed)', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: USER.id}).mockResolvedValueOnce(USER);
      mockTotp.status.mockResolvedValueOnce('pending');
      const out = await service.register(dto, '1.1.1.1');
      const upd = mockDb.q.mock.calls.find(c => String(c[0]).includes('UPDATE public.users SET password_hash'));
      expect(upd?.[1]).toEqual([USER.id, '$argon2id$new', 'A']);
      expect(out.secondFactor).toBe('totp_enrol');
    });
  });
});
