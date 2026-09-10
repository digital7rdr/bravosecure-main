import {Test, TestingModule} from '@nestjs/testing';
import {ConflictException, UnauthorizedException, BadRequestException, NotFoundException} from '@nestjs/common';
import {ConfigService}   from '@nestjs/config';
import {AuthService}     from './auth.service';
import {JwtService}      from './jwt.service';
import {DatabaseService} from '../database/database.service';
import {RedisService}    from '../redis/redis.service';
import {AuditService}    from '../kafka/audit.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService}      from '../common/services/otp.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';

// ── Mocks ─────────────────────────────────────────────────────────────────
const mockDb = {
  q:    jest.fn(),
  qOne: jest.fn(),
};
const mockRedis = {
  storeJti:  jest.fn(),
  revokeJti: jest.fn(),
  revokeJtis: jest.fn(),
  isJtiValid: jest.fn(),
  markPushRevoked:     jest.fn(),
  markPushRevokedMany: jest.fn(),
  clearPushRevoked:    jest.fn(),
  client: {get: jest.fn()}, // Bug 1: getMe.resolveAutoDispatchEnabled reads redis.client.get('dispatch:enabled')
};
const mockAudit  = {emit: jest.fn()};
const mockPw     = {hash: jest.fn(), verify: jest.fn()};
const mockOtp    = {generate: jest.fn(), hash: jest.fn(), send: jest.fn(), check: jest.fn()};
const mockJwt    = {
  signAccessToken: jest.fn(),
  newRefreshToken: jest.fn(),
  refreshTokenHash: jest.fn(),
  ttlToSeconds:    jest.fn(),
};
const mockConfig = {
  get: jest.fn((key: string) => {
    const map: Record<string, unknown> = {
      'jwt.refreshTtl':    '30d',
      'jwt.accessTtl':     '15m',
      'otp.ttlMinutes':    10,
      'otp.maxAttempts':   3,
      'otp.devReturnCode': false,
    };
    return map[key];
  }),
};

// ── Test suite ────────────────────────────────────────────────────────────
describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    // resetAllMocks clears both call history AND mockReturnValueOnce queues —
    // prevents stale Once values leaking between tests.
    jest.resetAllMocks();
    mockJwt.signAccessToken.mockResolvedValue({accessToken: 'tok', jti: 'jti-1'});
    mockJwt.newRefreshToken.mockReturnValue({token: 'ref', hash: 'ref-hash'});
    mockJwt.refreshTokenHash.mockReturnValue('hash');
    mockJwt.ttlToSeconds.mockImplementation((s: string) => s === '15m' ? 900 : 2_592_000);
    mockDb.q.mockResolvedValue([{id: 'user-1'}]);
    mockDb.qOne.mockResolvedValue(null);
    mockRedis.storeJti.mockResolvedValue(undefined);
    mockRedis.revokeJti.mockResolvedValue(undefined);
    mockRedis.revokeJtis.mockResolvedValue(undefined);
    mockRedis.markPushRevoked.mockResolvedValue(undefined);
    mockRedis.markPushRevokedMany.mockResolvedValue(undefined);
    mockRedis.clearPushRevoked.mockResolvedValue(undefined);
    mockAudit.emit.mockResolvedValue(undefined);
    // Password and OTP safe defaults — tests override as needed
    mockPw.verify.mockResolvedValue(false);
    mockPw.hash.mockResolvedValue('$argon2id$v=19$m=65536,t=3,p=4$mock');
    mockOtp.generate.mockReturnValue('000000');
    mockOtp.hash.mockReturnValue('otp-hash');
    mockOtp.send.mockResolvedValue(undefined);
    mockOtp.check.mockResolvedValue(false);   // Twilio Verify default; tests override

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
        {provide: TotpChallengeService, useValue: {status: jest.fn().mockResolvedValue('none'), enrol: jest.fn(), check: jest.fn()}},
      ],
    }).compile();
    service = module.get(AuthService);
  });

  // ── register ─────────────────────────────────────────────────────────────
  describe('register', () => {
    const dto = {email:'a@b.com', password:'pass1234', displayName:'A', phoneE164:'+15555550101'};

    it('throws ConflictException when email/phone already exists', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'existing'});
      await expect(service.register(dto as any, '1.2.3.4')).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.emit).toHaveBeenCalledWith(expect.objectContaining({outcome: 'failure'}));
    });

    it('sends an OTP without creating the user yet (step 1)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);   // no existing account
      const result = await service.register(dto as any, '1.2.3.4');
      // register() is step 1 of a two-step flow: dup-check + send the Twilio
      // OTP only. The password is hashed and the user row created in
      // registerVerify() once the OTP is approved.
      expect(mockOtp.send).toHaveBeenCalledWith(dto.phoneE164, '');
      expect(mockPw.hash).not.toHaveBeenCalled();
      expect(result).toEqual({userId: null, otpSentTo: dto.phoneE164, challengeId: null, secondFactor: 'sms', enrol: null});
    });

    it('emits audit success event', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      mockPw.hash.mockResolvedValueOnce('hash');
      mockOtp.generate.mockReturnValueOnce('000000');
      mockOtp.hash.mockReturnValueOnce('h');
      await service.register(dto as any, '1.2.3.4');
      expect(mockAudit.emit).toHaveBeenCalledWith(expect.objectContaining({event_type:'auth.register', outcome:'success'}));
    });
  });

  // ── registerVerify (step 2: Twilio approves → hash password + create user) ─
  describe('registerVerify', () => {
    const dto = {email:'a@b.com', password:'pass1234', displayName:'A', phoneE164:'+15555550101', code:'123456', deviceId:'d-1', platform:'android'};

    it('hashes the password and creates the user once the OTP is approved', async () => {
      mockOtp.check.mockResolvedValueOnce(true);            // Twilio approves
      mockDb.qOne
        .mockResolvedValueOnce(null)                         // dup-check: none
        .mockResolvedValueOnce({id:'user-1', email:'a@b.com', display_name:'A', role:'individual', subscription_tier:'lite', phone_e164:'+15555550101'})  // SELECT inserted user
        .mockResolvedValueOnce(null);                        // issueSession prev jti
      const result = await service.registerVerify(dto as any, '1.2.3.4');
      expect(mockOtp.check).toHaveBeenCalledWith(dto.phoneE164, dto.code);
      expect(mockPw.hash).toHaveBeenCalledWith(dto.password);
      expect(result.accessToken).toBe('tok');
    });

    it('rejects when the OTP is not approved — no user created', async () => {
      mockOtp.check.mockResolvedValueOnce(false);
      await expect(service.registerVerify(dto as any, '1.2.3.4')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPw.hash).not.toHaveBeenCalled();
    });
  });

  // ── login (ownership / no-enumeration) ───────────────────────────────────
  describe('login', () => {
    it('returns null userId on wrong credentials — no account enumeration', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      mockPw.verify.mockResolvedValueOnce(false);
      const result = await service.login({email:'x@x.com', password:'bad'} as any, '1.2.3.4');
      expect(result.userId).toBeNull();
      expect(result.otpSentTo).toBeNull();
    });

    it('returns null userId when account exists but password wrong', async () => {
      mockDb.qOne.mockResolvedValueOnce({id:'u1', email:'x@x.com', phone_e164:null, password_hash:'hash'});
      mockPw.verify.mockResolvedValueOnce(false);
      const result = await service.login({email:'x@x.com', password:'bad'} as any, '1.2.3.4');
      expect(result.userId).toBeNull();   // same shape — no enumeration
    });

    it('throws BadRequestException when neither email nor phone provided', async () => {
      await expect(service.login({password:'x'} as any, '1.2.3.4')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns userId and otpSentTo on correct credentials', async () => {
      const user = {id:'u-ok', email:'ok@ok.com', phone_e164:'+1999', password_hash:'hash', display_name:'OK', role:'individual', subscription_tier:'lite'};
      mockDb.qOne.mockResolvedValueOnce(user);
      mockPw.verify.mockResolvedValueOnce(true);
      mockOtp.generate.mockReturnValueOnce('654321');
      mockOtp.hash.mockReturnValueOnce('hashed');
      const result = await service.login({email:'ok@ok.com', password:'correct'} as any, '1.2.3.4');
      expect(result.userId).toBe('u-ok');
      expect(result.otpSentTo).toBeTruthy();
    });

    it('emits audit success on correct credentials', async () => {
      const user = {id:'u-ok', email:'ok@ok.com', phone_e164:'+1999', password_hash:'hash', display_name:'OK', role:'individual', subscription_tier:'lite'};
      mockDb.qOne.mockResolvedValueOnce(user);
      mockPw.verify.mockResolvedValueOnce(true);
      mockOtp.generate.mockReturnValueOnce('654321');
      mockOtp.hash.mockReturnValueOnce('hashed');
      await service.login({email:'ok@ok.com', password:'correct'} as any, '1.2.3.4');
      expect(mockAudit.emit).toHaveBeenCalledWith(expect.objectContaining({event_type:'auth.login', outcome:'success'}));
    });

    // DC-04 — a suspended (or deleted) account must be excluded by the lookup
    // itself, so a suspended user gets the same no-account response as bad creds.
    it('scopes the login lookup to non-suspended, non-deleted accounts', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const result = await service.login({email:'susp@x.com', password:'whatever'} as any, '1.2.3.4');
      expect(result.userId).toBeNull();
      const sql = String(mockDb.qOne.mock.calls[0][0]);
      expect(sql).toContain('deleted_at IS NULL');
      expect(sql).toContain('suspended_at IS NULL');
    });
  });

  // ── verify OTP ────────────────────────────────────────────────────────────
  describe('verify', () => {
    const dto = {userId:'u-1', code:'123456', deviceId:'d-1', platform:'android'};
    // verify() now looks up the USER first (must have a phone), then the
    // latest auth_otps row, then validates the code via Twilio (otp.check).
    const validUser = {id:'u-1', email:'a@b.com', display_name:'A', role:'individual', subscription_tier:'lite', phone_e164:'+15555550101'};
    const validOtp  = {id:'o1', expires_at: new Date(Date.now()+60_000), used_at:null, attempt_count:0};

    it('throws BadRequestException on no pending OTP', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(validUser)   // user lookup
        .mockResolvedValueOnce(null);        // no auth_otps row
      await expect(service.verify(dto as any, '1.1.1.1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when OTP already used', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(validUser)
        .mockResolvedValueOnce({...validOtp, used_at: new Date()});
      await expect(service.verify(dto as any, '1.1.1.1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException on expired OTP', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(validUser)
        .mockResolvedValueOnce({...validOtp, expires_at: new Date(Date.now()-1000)});
      await expect(service.verify(dto as any, '1.1.1.1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when max attempts reached', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(validUser)
        .mockResolvedValueOnce({...validOtp, attempt_count: 3});
      await expect(service.verify(dto as any, '1.1.1.1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('increments attempt_count on wrong code and returns attemptsLeft', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(validUser)
        .mockResolvedValueOnce(validOtp);
      mockOtp.check.mockResolvedValueOnce(false);   // Twilio rejects the code
      await expect(service.verify(dto as any, '1.1.1.1')).rejects.toMatchObject({
        response: expect.objectContaining({error: 'otp_invalid', attemptsLeft: 2}),
      });
      expect(mockDb.q).toHaveBeenCalledWith(expect.stringContaining('attempt_count'), [1, 'o1']);
    });

    it('issues tokens when OTP correct — jti stored in Redis', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(validUser)    // user lookup
        .mockResolvedValueOnce(validOtp)      // pending OTP
        .mockResolvedValueOnce(null);          // issueSession prev jti
      mockOtp.check.mockResolvedValueOnce(true);   // Twilio approves
      const result = await service.verify(dto as any, '1.1.1.1');
      expect(result.accessToken).toBe('tok');
      expect(mockRedis.storeJti).toHaveBeenCalledWith('jti-1', 900);
    });

    // B-71 — single-device takeover is mobile-only. A web (ops-console) login
    // must NOT force-revoke the account's other web devices; doing so made two
    // ops tabs mutually evict each other → `token_revoked` → login loop.
    it('does NOT evict other web sessions on a web login', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(validUser)
        .mockResolvedValueOnce(validOtp)
        .mockResolvedValueOnce(null);          // issueSession prev jti
      mockOtp.check.mockResolvedValueOnce(true);
      await service.verify({...dto, platform: 'web'} as any, '1.1.1.1');
      // markPushRevokedMany fires ONLY from the eviction cascade in the verify
      // path, so its absence proves the takeover was skipped for web.
      expect(mockRedis.markPushRevokedMany).not.toHaveBeenCalled();
    });

    it('evicts other same-platform devices on a mobile login (single-device)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(validUser)
        .mockResolvedValueOnce(validOtp)
        .mockResolvedValueOnce(null);
      mockOtp.check.mockResolvedValueOnce(true);
      await service.verify({...dto, platform: 'android'} as any, '1.1.1.1');
      expect(mockRedis.markPushRevokedMany).toHaveBeenCalled();
    });
  });

  // ── delete session (ownership enforcement) ───────────────────────────────
  describe('deleteSession', () => {
    it('only revokes jtis belonging to the calling user (single device)', async () => {
      const callerUserId = 'user-123';
      mockDb.qOne.mockResolvedValueOnce({current_jti: 'jti-abc'});
      await service.deleteSession({deviceId: 'dev-1'} as any, callerUserId, '1.1.1.1');

      // ownership check: SQL must include WHERE user_id=$1 with the caller's id
      const updateCall = mockDb.q.mock.calls.find(c => String(c[0]).includes('revoked_at=now()'));
      expect(updateCall?.[1]).toContain(callerUserId);   // user_id param is caller's
      // The revoke must cascade to push-token cleanup for the killed device.
      expect(mockRedis.markPushRevoked).toHaveBeenCalledWith(callerUserId, 'dev-1');
    });

    it('revokes all active jtis for the user when allDevices=true', async () => {
      mockDb.q.mockResolvedValueOnce([
        {current_jti:'j1', device_id:'d1'},
        {current_jti:'j2', device_id:'d2'},
      ]);
      await service.deleteSession({deviceId:'x', allDevices:true} as any, 'user-X', '1.1.1.1');
      expect(mockRedis.revokeJtis).toHaveBeenCalledWith(['j1','j2']);
      // Every revoked device gets a push-revoke tombstone so its (possibly
      // killed) app stops receiving the account's wake stream.
      expect(mockRedis.markPushRevokedMany).toHaveBeenCalledWith([
        {userId:'user-X', deviceId:'d1'},
        {userId:'user-X', deviceId:'d2'},
      ]);
    });
  });

  // ── refresh token (ownership via hash lookup) ─────────────────────────────
  describe('refresh', () => {
    it('throws UnauthorizedException on unknown refresh token', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.refresh({refreshToken:'bad'} as any, '1.1.1.1')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException when device is revoked', async () => {
      mockDb.qOne.mockResolvedValueOnce({user_id:'u', device_id:'d', platform:'android', expires_at: new Date(Date.now()+9999), revoked_at: new Date()});
      await expect(service.refresh({refreshToken:'ok'} as any, '1.1.1.1')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException on expired refresh token', async () => {
      mockDb.qOne.mockResolvedValueOnce({user_id:'u', device_id:'d', platform:'ios', expires_at: new Date(Date.now()-1000), revoked_at: null});
      await expect(service.refresh({refreshToken:'exp'} as any, '1.1.1.1')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('issues new session on valid refresh token', async () => {
      const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);  // 7 days from now
      const device = {user_id:'u-1', device_id:'d-1', platform:'ios', expires_at: future, revoked_at: null};
      const user   = {id:'u-1', email:'a@b.com', display_name:'A', role:'individual', subscription_tier:'lite', phone_e164:null};
      mockDb.qOne
        .mockResolvedValueOnce(device)
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(null);    // prev jti check
      const result = await service.refresh({refreshToken:'valid'} as any, '1.1.1.1');
      expect(result.accessToken).toBe('tok');
    });
  });

  // ── getMe ─────────────────────────────────────────────────────────────────
  describe('getMe', () => {
    it('returns user object for valid userId', async () => {
      const user = {id:'u-1', email:'a@b.com', display_name:'A', role:'individual', subscription_tier:'lite', phone_e164:null};
      mockDb.qOne.mockResolvedValue(user);   // both getMe queries (user + resolveAccountKind) get it
      const result = await service.getMe('u-1');
      expect(result.user.email).toBe('a@b.com');
      // lock the getMe → resolveAccountKind wiring (account_kind is spread into the response)
      expect(result.account_kind).toBe('individual');
    });

    it('throws NotFoundException when user not found', async () => {
      // qOne defaults to null from beforeEach — nothing to override
      await expect(service.getMe('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    // Bug 1 — server-driven auto-dispatch flag mirrors DispatchKillswitchService:
    // effective = env (featureFlags.autoDispatch) AND redis dispatch:enabled !== 'false'.
    describe('auto_dispatch_enabled', () => {
      const user = {id:'u-1', email:'a@b.com', display_name:'A', role:'individual', subscription_tier:'lite', phone_e164:null};
      beforeEach(() => { mockRedis.client.get.mockReset(); mockDb.qOne.mockResolvedValue(user); });

      it('env OFF → false, without touching Redis', async () => {
        // default mockConfig.get returns undefined for featureFlags.autoDispatch → env off
        const r = await service.getMe('u-1');
        expect(r.auto_dispatch_enabled).toBe(false);
        expect(mockRedis.client.get).not.toHaveBeenCalled();
      });

      it('env ON + redis absent → true', async () => {
        mockConfig.get.mockImplementationOnce(() => true); // the single config.get in getMe = featureFlags.autoDispatch
        mockRedis.client.get.mockResolvedValue(null);
        const r = await service.getMe('u-1');
        expect(r.auto_dispatch_enabled).toBe(true);
      });

      it("env ON + redis 'false' → false (runtime kill)", async () => {
        mockConfig.get.mockImplementationOnce(() => true);
        mockRedis.client.get.mockResolvedValue('false');
        const r = await service.getMe('u-1');
        expect(r.auto_dispatch_enabled).toBe(false);
      });

      it('env ON + redis throws → falls back to env (true), never crashes /auth/me', async () => {
        mockConfig.get.mockImplementationOnce(() => true);
        mockRedis.client.get.mockRejectedValue(new Error('redis down'));
        const r = await service.getMe('u-1');
        expect(r.auto_dispatch_enabled).toBe(true);
      });
    });
  });

  // ── updateProfile ──────────────────────────────────────────────────────────
  describe('updateProfile', () => {
    const row = {id:'u-1', email:'a@b.com', display_name:'A', role:'individual', subscription_tier:'lite', phone_e164:null, avatar_url:null};

    it('updates display_name and returns the fresh user', async () => {
      mockDb.qOne.mockResolvedValue({...row, display_name:'New'});
      const result = await service.updateProfile('u-1', {display_name:'New'});
      expect(result.user.display_name).toBe('New');
      expect(mockDb.qOne).toHaveBeenCalledTimes(1);
      // user id is always the first param; display_name follows.
      expect(mockDb.qOne.mock.calls[0][1]).toEqual(['u-1', 'New']);
    });

    it('passes null through so the avatar can be cleared', async () => {
      mockDb.qOne.mockResolvedValue(row);
      await service.updateProfile('u-1', {avatar_url: null});
      expect(mockDb.qOne.mock.calls[0][1]).toEqual(['u-1', null]);
    });

    it('falls back to getMe when no fields are supplied', async () => {
      mockDb.qOne.mockResolvedValue(row);
      const result = await service.updateProfile('u-1', {});
      expect(result.user.id).toBe('u-1');
    });
  });

  // ── RS-05: getCurrentRole (fresh DB role read) ─────────────────────────────
  describe('getCurrentRole', () => {
    it('returns the role from a fresh, soft-delete-aware SELECT', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'service_provider'});
      const role = await service.getCurrentRole('u-9');
      expect(role).toBe('service_provider');
      const [sql, params] = mockDb.qOne.mock.calls[0];
      expect(String(sql)).toMatch(/SELECT role FROM public\.users/i);
      expect(String(sql)).toMatch(/deleted_at IS NULL/);
      expect(params).toEqual(['u-9']);
    });

    it('throws NotFoundException for a missing/soft-deleted user', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.getCurrentRole('gone')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── RS-01: revokeAllUserSessions (reused DC-04 eject mechanism) ─────────────
  describe('revokeAllUserSessions', () => {
    it('revokes only non-null JTIs, clears auth_devices, push-revokes each device, audits and returns the count', async () => {
      mockDb.q.mockResolvedValueOnce([
        {current_jti: 'j1', device_id: 'd1'},
        {current_jti: null, device_id: 'd2'},
      ]); // the SELECT of live devices
      const n = await service.revokeAllUserSessions('u-9');
      expect(n).toBe(2);
      expect(mockRedis.revokeJtis).toHaveBeenCalledWith(['j1']); // null filtered out
      const update = mockDb.q.mock.calls.find(c => /UPDATE auth_devices SET revoked_at/i.test(String(c[0])));
      expect(update).toBeDefined();
      expect(mockRedis.markPushRevokedMany).toHaveBeenCalledWith([
        {userId: 'u-9', deviceId: 'd1'},
        {userId: 'u-9', deviceId: 'd2'},
      ]);
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.session.revoked', detail: 'membership_revoked'}),
      );
    });

    it('is a no-op returning 0 when the user has no live sessions', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      const n = await service.revokeAllUserSessions('u-9');
      expect(n).toBe(0);
      expect(mockRedis.revokeJtis).toHaveBeenCalledWith([]);
    });
  });

  // ── RS-09: the self-grant-ADMIN method is gone (cannot be reintroduced) ─────
  it('has no adminRegisterVerify method (RS-09 self-grant-ADMIN code deleted)', () => {
    expect((service as unknown as {adminRegisterVerify?: unknown}).adminRegisterVerify).toBeUndefined();
  });
});
