/**
 * Audit Rev2 SEC-01 — "JWTs work with an empty secret".
 *
 * `jwt.service.ts` did `config.get('jwt.accessSecret') ?? ''` and
 * `configuration.ts` defaulted the secret to ''. Signing AND verifying HS256
 * with a zero-length key is SELF-CONSISTENT — the service boots, tokens
 * round-trip, every test passes — while anyone who knows this can forge
 * `{sub: <any user>, role: 'admin'}`. The `?? ''` was a TypeScript reflex:
 * `config.get` returns `string | undefined`, the compiler wants a default, and
 * '' is the shortest thing that compiles. The type system was satisfied; the
 * security property was not.
 *
 * WHY THE CHECK LIVES HERE AND NOT IN THE GETTER:
 *   auth-service has NO global exception filter, so a throwing getter becomes a
 *   bare 500 on the sign path and — because JwtAuthGuard catches everything and
 *   rethrows UnauthorizedException('invalid_token') — a MISLEADING 401 on every
 *   authed route. Fail once, loudly, at config load (inside NestFactory.create,
 *   before app.listen), exactly like totpEncryptionKey() already does.
 *
 * WHY AN EMPTY-CHECK ALONE IS NOT ENOUGH:
 *   infra/env/auth.env.example ships the literal
 *   `JWT_ACCESS_SECRET=<replace-with-output-of-openssl-rand-base64-64>` and
 *   bootstrap-staging.sh copies it verbatim to /etc/bravo/auth.env. That is not
 *   empty. And docker-compose.yml publishes a 53-char dev secret with no angle
 *   brackets, which passes both a length and a placeholder test.
 */

// `export {}` makes this file a MODULE. Without it TypeScript treats a spec
// with no top-level import/export as a global SCRIPT, and `loadConfig` here
// collides with the identically-named helper in configuration.spec.ts
// ("TS2393: Duplicate function implementation") — which fails the OTHER suite,
// not this one.
export {};

type Cfg = ReturnType<typeof import('./configuration').default>;

function loadConfig(env: Record<string, string | undefined>): Cfg {
  const saved = process.env;
  process.env = {...saved, ...env};
  let cfg: Cfg;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cfg = (require('./configuration').default as () => Cfg)();
  });
  process.env = saved;
  // @ts-expect-error assigned inside isolateModules callback
  return cfg;
}

/** Production needs a real TOTP key or configuration() throws for an unrelated reason. */
const PROD = {NODE_ENV: 'production', TOTP_ENCRYPTION_KEY: '0'.repeat(64)};
const GOOD_ACCESS = 'A'.repeat(64);
const GOOD_ACTION = 'B'.repeat(88);

describe('SEC-01 — JWT secrets must be real in production', () => {
  it('refuses to boot when JWT_ACCESS_SECRET is missing', () => {
    expect(() => loadConfig({...PROD, JWT_ACCESS_SECRET: undefined, JWT_ACTION_SECRET: GOOD_ACTION}))
      .toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses to boot when JWT_ACCESS_SECRET is blank or whitespace', () => {
    expect(() => loadConfig({...PROD, JWT_ACCESS_SECRET: '   ', JWT_ACTION_SECRET: GOOD_ACTION}))
      .toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses the <replace-me> placeholder that bootstrap-staging.sh copies verbatim', () => {
    expect(() => loadConfig({
      ...PROD,
      JWT_ACCESS_SECRET: '<replace-with-output-of-openssl-rand-base64-64>',
      JWT_ACTION_SECRET: GOOD_ACTION,
    })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses a secret shorter than 32 chars', () => {
    expect(() => loadConfig({...PROD, JWT_ACCESS_SECRET: 'short', JWT_ACTION_SECRET: GOOD_ACTION}))
      .toThrow(/JWT_ACCESS_SECRET/);
  });

  // The one the length + placeholder rules both wave through.
  it('refuses the development secret published in docker-compose.yml', () => {
    expect(() => loadConfig({
      ...PROD,
      JWT_ACCESS_SECRET: 'dev-access-secret-do-not-use-in-prod-xxxxxxxxxxxxxxxx',
      JWT_ACTION_SECRET: GOOD_ACTION,
    })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses to boot when JWT_ACTION_SECRET is missing — it must NOT inherit the access secret', () => {
    // The old configuration.ts read
    //   actionSecret: JWT_ACTION_SECRET ?? JWT_ACCESS_SECRET ?? ''
    // so a File Vault MFA step-up token and an ordinary session token could be
    // signed with the SAME key, defeating the entire point of a step-up.
    expect(() => loadConfig({...PROD, JWT_ACCESS_SECRET: GOOD_ACCESS, JWT_ACTION_SECRET: undefined}))
      .toThrow(/JWT_ACTION_SECRET/);
  });

  it('refuses to boot when the action secret equals the access secret', () => {
    expect(() => loadConfig({...PROD, JWT_ACCESS_SECRET: GOOD_ACCESS, JWT_ACTION_SECRET: GOOD_ACCESS}))
      .toThrow(/JWT_ACTION_SECRET/);
  });

  it('accepts real, distinct secrets and passes them through unchanged', () => {
    const cfg = loadConfig({...PROD, JWT_ACCESS_SECRET: GOOD_ACCESS, JWT_ACTION_SECRET: GOOD_ACTION});
    expect(cfg.jwt.accessSecret).toBe(GOOD_ACCESS);
    expect(cfg.jwt.actionSecret).toBe(GOOD_ACTION);
  });

  it('does not brick local development — dev gets usable, DISTINCT fallbacks', () => {
    // Mirrors totpEncryptionKey(): fail closed in production, keep a local run
    // booting without secrets. The fallbacks must differ from each other, or
    // the action/access separation is broken in dev too.
    const cfg = loadConfig({NODE_ENV: 'development', JWT_ACCESS_SECRET: undefined, JWT_ACTION_SECRET: undefined});
    expect(cfg.jwt.accessSecret.length).toBeGreaterThanOrEqual(32);
    expect(cfg.jwt.actionSecret.length).toBeGreaterThanOrEqual(32);
    expect(cfg.jwt.actionSecret).not.toBe(cfg.jwt.accessSecret);
  });
});
