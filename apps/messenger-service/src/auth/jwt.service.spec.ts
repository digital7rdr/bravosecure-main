import {Test} from '@nestjs/testing';
import {ConfigService} from '@nestjs/config';
import {SignJWT} from 'jose';
import {randomUUID} from 'node:crypto';
import {JwtService} from './jwt.service';

const SECRET = 'test-secret-at-least-32-characters-long-aa';

async function sign(opts: {
  sub?: string;
  deviceId?: string;
  role?: string;
  jti?: string;
  issuer?: string;
  audience?: string;
  secret?: string;
  expired?: boolean;
}): Promise<string> {
  const key = new TextEncoder().encode(opts.secret ?? SECRET);
  const t = new SignJWT({
    device_id: opts.deviceId ?? 'dev-1',
    role:      opts.role ?? 'individual',
  })
    .setProtectedHeader({alg: 'HS256'})
    .setSubject(opts.sub ?? 'user-1')
    .setJti(opts.jti ?? randomUUID())
    .setIssuedAt()
    .setIssuer(opts.issuer ?? 'auth-service')
    .setAudience(opts.audience ?? 'bravo-api');
  return opts.expired
    ? t.setExpirationTime('1s').sign(key).then(async tok => {
        await new Promise(r => setTimeout(r, 1100));
        return tok;
      })
    : t.setExpirationTime('5m').sign(key);
}

function makeService(overrides: Record<string, string> = {}): JwtService {
  const config: Partial<ConfigService> = {
    get: (k: string) => ({
      'jwt.accessSecret': SECRET,
      'jwt.issuer':       'auth-service',
      'jwt.audience':     'bravo-api',
      ...overrides,
    }[k] as string),
  };
  return new JwtService(config as ConfigService);
}

describe('JwtService', () => {
  it('accepts a valid token and returns claims', async () => {
    const svc = makeService();
    const token = await sign({sub: 'alice', deviceId: 'phone-1', role: 'individual'});
    const claims = await svc.verifyAccessToken(token);
    expect(claims.sub).toBe('alice');
    expect(claims.deviceId).toBe('phone-1');
    expect(claims.role).toBe('individual');
    expect(claims.jti).toBeTruthy();
  });

  it('rejects a token signed with a different secret', async () => {
    const svc = makeService();
    const token = await sign({secret: 'other-secret-at-least-32-characters-long'});
    await expect(svc.verifyAccessToken(token)).rejects.toBeDefined();
  });

  it('rejects wrong issuer', async () => {
    const svc = makeService();
    const token = await sign({issuer: 'someone-else'});
    await expect(svc.verifyAccessToken(token)).rejects.toBeDefined();
  });

  it('rejects wrong audience', async () => {
    const svc = makeService();
    const token = await sign({audience: 'other-api'});
    await expect(svc.verifyAccessToken(token)).rejects.toBeDefined();
  });

  it('rejects missing device_id', async () => {
    const svc = makeService();
    const token = await sign({deviceId: ''});
    await expect(svc.verifyAccessToken(token)).rejects.toThrow(/missing_device_id/);
  });

  // ─── Audit P3 — access secret must fail CLOSED like the action secret ───
  it('refuses to verify ANY token when the access secret is empty (fail closed)', async () => {
    const svc = makeService({'jwt.accessSecret': ''});
    // Even a token HMAC-signed with the empty string must be denied —
    // this is the forgery an empty-secret deploy used to accept.
    const token = await sign({});
    await expect(svc.verifyAccessToken(token)).rejects.toThrow(/JWT_ACCESS_SECRET not configured/);
  });

  // ─── Audit P0-3 — algorithms allowlist (alg-confusion defence) ────
  //
  // jose's default is "accept any alg matching the key shape." For a
  // symmetric secret that means HS256/HS384/HS512 all pass; if the
  // secret is ever swapped for a PEM-backed asymmetric key it ALSO
  // accepts RS256/ES256 by default — opening RFC 7519 §8.1 attacks
  // where the attacker signs an HS256 token using the public key as
  // the HMAC secret. The pin removes the gap permanently.

  it('audit P0-3 — rejects an HS384 token even though the secret would mathematically verify', async () => {
    const svc = makeService();
    // Same secret, different alg in header.
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({device_id: 'd', role: 'r'})
      .setProtectedHeader({alg: 'HS384'})
      .setSubject('alice')
      .setJti(randomUUID())
      .setIssuedAt()
      .setIssuer('auth-service')
      .setAudience('bravo-api')
      .setExpirationTime('5m')
      .sign(key);
    await expect(svc.verifyAccessToken(token)).rejects.toBeDefined();
  });

  it('audit P0-3 — rejects an unsigned (alg=none) token', async () => {
    const svc = makeService();
    // Build {alg:'none'}.{...}. manually. jose's SignJWT refuses
    // alg=none, so construct the wire-shape token by hand.
    const header  = Buffer.from(JSON.stringify({alg: 'none', typ: 'JWT'})).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub: 'alice', device_id: 'd', role: 'r', jti: 'x',
      iss: 'auth-service', aud: 'bravo-api',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })).toString('base64url');
    const token = `${header}.${payload}.`;
    await expect(svc.verifyAccessToken(token)).rejects.toBeDefined();
  });
});
