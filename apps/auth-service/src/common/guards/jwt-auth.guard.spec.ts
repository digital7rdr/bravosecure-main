import {ExecutionContext, UnauthorizedException} from '@nestjs/common';
import {JwtAuthGuard}  from './jwt-auth.guard';
import {JwtService}    from '../../auth/jwt.service';
import {RedisService}  from '../../redis/redis.service';

const mockJwt   = {verifyAccessToken: jest.fn()};
const mockRedis = {isJtiValid: jest.fn()};

const CLAIMS = {sub:'u-1', deviceId:'d-1', role:'individual', jti:'jti-valid'};

function makeCtx(authorization?: string): ExecutionContext {
  const req = {headers: authorization ? {authorization} : {}, ip: '1.1.1.1'} as any;
  return {
    switchToHttp: () => ({getRequest: () => req}),
  } as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jest.resetAllMocks();
    guard = new JwtAuthGuard(mockJwt as unknown as JwtService, mockRedis as unknown as RedisService);
  });

  it('throws UnauthorizedException when Authorization header is missing', async () => {
    await expect(guard.canActivate(makeCtx())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws UnauthorizedException when header does not start with Bearer', async () => {
    await expect(guard.canActivate(makeCtx('Basic abc123'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws UnauthorizedException on invalid JWT', async () => {
    mockJwt.verifyAccessToken.mockRejectedValueOnce(new Error('invalid'));
    await expect(guard.canActivate(makeCtx('Bearer bad.token'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws UnauthorizedException with token_revoked when jti not in Redis', async () => {
    mockJwt.verifyAccessToken.mockResolvedValueOnce(CLAIMS);
    mockRedis.isJtiValid.mockResolvedValueOnce(false);
    const err = await guard.canActivate(makeCtx('Bearer valid.token.here')).catch(e => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('token_revoked');
  });

  it('returns true and sets req.user on valid token with live jti', async () => {
    mockJwt.verifyAccessToken.mockResolvedValueOnce(CLAIMS);
    mockRedis.isJtiValid.mockResolvedValueOnce(true);
    const ctx = makeCtx('Bearer valid.jwt.token');
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(ctx.switchToHttp().getRequest().user).toEqual(CLAIMS);
  });
});
