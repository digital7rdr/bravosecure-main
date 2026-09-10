/**
 * B-39 — dev auth bypasses (OTP + biometric) must be impossible to activate in
 * production. `OtpService.check()` treats devBypass as "accept any 4-8 digit
 * code", so a stray OTP_DEV_BYPASS=true in a prod deploy silently collapses the
 * admin/login MFA to single-factor (the QA-observed "any code logs in"). The
 * config-level guard forces every dev-skip off when NODE_ENV=production.
 *
 * IS_PROD is captured at module load, so each case resets modules and re-imports
 * after setting the environment.
 */

function loadConfig(env: Record<string, string | undefined>): ReturnType<typeof import('./configuration').default> {
  const saved = process.env;
  process.env = {...saved, ...env};
  let cfg: ReturnType<typeof import('./configuration').default>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cfg = (require('./configuration').default as () => ReturnType<typeof import('./configuration').default>)();
  });
  process.env = saved;
  // @ts-expect-error assigned inside isolateModules callback
  return cfg;
}

describe('configuration — B-39 dev-bypass production guard', () => {
  it('honors OTP_DEV_BYPASS outside production (staging convenience)', () => {
    const cfg = loadConfig({NODE_ENV: 'staging', OTP_DEV_BYPASS: 'true'});
    expect(cfg.otp.devBypass).toBe(true);
  });

  it('forces OTP + biometric dev-bypass OFF in production even when env vars are set', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      // P1-P-1 — a real key is now required in production or configuration()
      // throws at boot; supply one so this dev-bypass assertion still runs.
      TOTP_ENCRYPTION_KEY: '0'.repeat(64),
      // Audit Rev2 SEC-01 — same reasoning, for the JWT secrets.
      JWT_ACCESS_SECRET: 'A'.repeat(64),
      JWT_ACTION_SECRET: 'B'.repeat(88),
      OTP_DEV_BYPASS: 'true',
      OTP_DEV_RETURN_CODE: 'true',
      BIOMETRIC_DEV_BYPASS: 'true',
    });
    expect(cfg.otp.devBypass).toBe(false);
    expect(cfg.otp.devReturnCode).toBe(false);
    expect(cfg.biometric.devBypass).toBe(false);
  });

  it('leaves dev-bypass off by default when the env var is unset', () => {
    const cfg = loadConfig({NODE_ENV: 'development', OTP_DEV_BYPASS: undefined});
    expect(cfg.otp.devBypass).toBe(false);
  });
});

// P1-P-1 — TOTP_ENCRYPTION_KEY must fail CLOSED at boot in production.
describe('configuration — P1-P-1 TOTP_ENCRYPTION_KEY fail-closed', () => {
  // Safe loader: restores process.env even when configuration() throws.
  function attempt(env: Record<string, string | undefined>): {
    run: () => ReturnType<typeof import('./configuration').default>;
  } {
    return {
      run: () => {
        const saved = process.env;
        process.env = {...saved, ...env};
        try {
          let cfg!: ReturnType<typeof import('./configuration').default>;
          jest.isolateModules(() => {
            cfg = (require('./configuration').default as () => ReturnType<typeof import('./configuration').default>)();
          });
          return cfg;
        } finally {
          process.env = saved;
        }
      },
    };
  }

  // Audit Rev2 SEC-01 — the JWT secrets are now validated at config load too,
  // and jwt is built BEFORE totp, so a production case with no JWT secrets now
  // throws for the wrong reason. Supply real ones so these keep asserting what
  // they were written to assert. (Both assertions match a SPECIFIC message, so
  // they could not have silently passed on the JWT error.)
  const PROD_JWT = {JWT_ACCESS_SECRET: 'A'.repeat(64), JWT_ACTION_SECRET: 'B'.repeat(88)};

  it('throws at boot in production when TOTP_ENCRYPTION_KEY is unset', () => {
    expect(attempt({NODE_ENV: 'production', ...PROD_JWT, TOTP_ENCRYPTION_KEY: undefined}).run)
      .toThrow(/TOTP_ENCRYPTION_KEY must be set in production/);
  });

  it('boots in production when a real key is provided', () => {
    const cfg = attempt({NODE_ENV: 'production', ...PROD_JWT, TOTP_ENCRYPTION_KEY: '0'.repeat(64)}).run();
    expect(cfg.totp.encryptionKey).toBe('0'.repeat(64));
  });

  it('falls back to a dev key outside production so a local run still boots', () => {
    const cfg = attempt({NODE_ENV: 'development', TOTP_ENCRYPTION_KEY: undefined}).run();
    expect(cfg.totp.encryptionKey).toHaveLength(64);
  });
});
