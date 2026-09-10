import {SignJWT} from 'jose';
import {ConfigService} from '@nestjs/config';
import {ExecutionContext, UnauthorizedException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {JwtService} from '../auth/jwt.service';
import type {RedisService} from '../redis/redis.service';
import {MfaGuard} from './mfa.guard';

const ACTION_SECRET = 'messenger-action-secret-at-least-32-chars-long';

function fakeCtx(headers: Record<string, string>, caller?: {sub: string; deviceId: string}) {
  const req: Record<string, unknown> = {
    headers,
    caller: caller ? {claims: {sub: caller.sub, deviceId: caller.deviceId}} : undefined,
  };
  return {
    switchToHttp: () => ({getRequest: () => req}),
  } as unknown as ExecutionContext;
}

async function mintAction(params: {
  sub?:       string;
  deviceId?:  string;
  purpose?:   string;
  secret?:    string;
  issuer?:    string;
  audience?:  string;
  iat?:       number;
  expiresIn?: string;
}): Promise<string> {
  const key = new TextEncoder().encode(params.secret ?? ACTION_SECRET);
  return new SignJWT({
    device_id: params.deviceId ?? 'dev-1',
    purpose:   params.purpose  ?? 'biometric-verified',
  })
    .setProtectedHeader({alg: 'HS256'})
    .setSubject(params.sub ?? 'alice')
    .setJti(randomUUID())
    .setIssuedAt(params.iat)
    .setIssuer(params.issuer ?? 'auth-service')
    .setAudience(params.audience ?? 'bravo-action')
    .setExpirationTime(params.expiresIn ?? '5m')
    .sign(key);
}

// P3 replay fix — in-memory Redis stub with real SET NX semantics so the
// single-use-jti tests exercise the actual claim/deny behavior.
function makeRedisStub(): {redis: RedisService; setMock: jest.Mock; store: Set<string>} {
  const store = new Set<string>();
  const setMock = jest.fn(async (key: string, _v: string, _ex: string, _ttl: number, nx?: string) => {
    if (nx === 'NX' && store.has(key)) return null;
    store.add(key);
    return 'OK';
  });
  return {redis: {client: {set: setMock}} as unknown as RedisService, setMock, store};
}

function makeGuard(overrides: Record<string, unknown> = {}, redis?: RedisService) {
  const cfg: Partial<ConfigService> = {
    get: (k: string): unknown => ({
      'jwt.accessSecret':   'unused-here',
      'jwt.actionSecret':   ACTION_SECRET,
      'jwt.issuer':         'auth-service',
      'jwt.audience':       'bravo-api',
      'jwt.actionAudience': 'bravo-action',
      'vault.mfaPurposes':  ['biometric-verified', 'totp-verified', 'vault-access'],
      'vault.mfaMaxAgeSec': 300,
      ...overrides,
    }[k] as unknown),
  };
  const jwt = new JwtService(cfg as ConfigService);
  return new MfaGuard(jwt, cfg as ConfigService, redis ?? makeRedisStub().redis);
}

describe('MfaGuard', () => {
  it('accepts a fresh action token with allowed purpose + matching caller', async () => {
    const guard = makeGuard();
    const tok = await mintAction({sub: 'alice', deviceId: 'dev-1', purpose: 'biometric-verified'});
    const ctx = fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects when header missing', async () => {
    const guard = makeGuard();
    const ctx = fakeCtx({}, {sub: 'alice', deviceId: 'dev-1'});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a purpose not in the allowlist', async () => {
    const guard = makeGuard();
    const tok = await mintAction({purpose: 'password-reset'});
    const ctx = fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
    await expect(guard.canActivate(ctx)).rejects.toThrow(/purpose_not_allowed/);
  });

  it('rejects a stale action token (iat older than maxAge)', async () => {
    const guard = makeGuard({'vault.mfaMaxAgeSec': 10});
    const tok = await mintAction({iat: Math.floor(Date.now() / 1000) - 3600});
    const ctx = fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
    await expect(guard.canActivate(ctx)).rejects.toThrow(/mfa_proof_stale/);
  });

  it('rejects a sub / device mismatch with the caller context', async () => {
    const guard = makeGuard();
    const tok = await mintAction({sub: 'mallory', deviceId: 'dev-1'});
    const ctx = fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
    await expect(guard.canActivate(ctx)).rejects.toThrow(/mfa_sub_mismatch/);
  });

  it('rejects a different device id even when sub matches', async () => {
    const guard = makeGuard();
    const tok = await mintAction({sub: 'alice', deviceId: 'dev-other'});
    const ctx = fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
    await expect(guard.canActivate(ctx)).rejects.toThrow(/mfa_device_mismatch/);
  });

  it('rejects action tokens signed with the wrong secret', async () => {
    const guard = makeGuard();
    const tok = await mintAction({secret: 'different-action-secret-32-chars-ok'});
    const ctx = fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects wrong audience (not bravo-action)', async () => {
    const guard = makeGuard();
    const tok = await mintAction({audience: 'bravo-api'});
    const ctx = fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── P3 — single-use jti (replay defence) ──────────────────────────
  describe('single-use proof jti', () => {
    it('rejects a REPLAY of the same proof within its freshness window', async () => {
      const {redis} = makeRedisStub();
      const guard = makeGuard({}, redis);
      const tok = await mintAction({sub: 'alice', deviceId: 'dev-1'});
      const ctx = () => fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
      await expect(guard.canActivate(ctx())).resolves.toBe(true);
      await expect(guard.canActivate(ctx())).rejects.toThrow(/mfa_proof_replayed/);
    });

    it('distinct proofs (fresh jtis) each pass once', async () => {
      const {redis} = makeRedisStub();
      const guard = makeGuard({}, redis);
      const tok1 = await mintAction({sub: 'alice', deviceId: 'dev-1'});
      const tok2 = await mintAction({sub: 'alice', deviceId: 'dev-1'});
      await expect(guard.canActivate(fakeCtx({'x-mfa-proof': tok1}, {sub: 'alice', deviceId: 'dev-1'}))).resolves.toBe(true);
      await expect(guard.canActivate(fakeCtx({'x-mfa-proof': tok2}, {sub: 'alice', deviceId: 'dev-1'}))).resolves.toBe(true);
    });

    it('claims the jti with SET NX and a TTL bounded by the remaining freshness window', async () => {
      const {redis, setMock} = makeRedisStub();
      const guard = makeGuard({}, redis);
      const tok = await mintAction({sub: 'alice', deviceId: 'dev-1', iat: Math.floor(Date.now() / 1000) - 100});
      await guard.canActivate(fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'}));
      expect(setMock).toHaveBeenCalledTimes(1);
      const [key, , ex, ttl, nx] = setMock.mock.calls[0];
      expect(key).toMatch(/^vault:mfa-proof-used:/);
      expect(ex).toBe('EX');
      expect(nx).toBe('NX');
      // maxAge 300 − age ~100 → ~200 s remaining; never more than maxAge.
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(200);
    });

    it('fails CLOSED when Redis is unavailable', async () => {
      const redis = {client: {set: jest.fn().mockRejectedValue(new Error('conn refused'))}} as unknown as RedisService;
      const guard = makeGuard({}, redis);
      const tok = await mintAction({sub: 'alice', deviceId: 'dev-1'});
      const ctx = fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
      await expect(guard.canActivate(ctx)).rejects.toThrow(/mfa_proof_state_unavailable/);
    });

    it('does not burn the jti when an earlier check fails (bad purpose never reaches Redis)', async () => {
      const {redis, setMock} = makeRedisStub();
      const guard = makeGuard({}, redis);
      const tok = await mintAction({purpose: 'password-reset'});
      const ctx = fakeCtx({'x-mfa-proof': tok}, {sub: 'alice', deviceId: 'dev-1'});
      await expect(guard.canActivate(ctx)).rejects.toThrow(/purpose_not_allowed/);
      expect(setMock).not.toHaveBeenCalled();
    });
  });
});
