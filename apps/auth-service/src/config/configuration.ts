// B-39 hardening — dev auth bypasses (OTP + biometric) must NEVER be honored in
// production, even if the env var is mistakenly set. `check()` treats devBypass
// as "accept any code", so a stray OTP_DEV_BYPASS=true in a prod deploy collapses
// MFA to single-factor. Force every dev-skip off when NODE_ENV=production so the
// real Twilio Verify / integrity path is the only route in prod.
const IS_PROD = (process.env['NODE_ENV'] ?? 'development') === 'production';
const devFlag = (envVar: string | undefined): boolean => !IS_PROD && envVar === 'true';

// P1-P-1 — 2FA seed at-rest encryption key. NEVER fall back to a literal
// key in production: an unset TOTP_ENCRYPTION_KEY there would seal every
// user's TOTP secret under a publicly-known constant, so a DB/backup leak
// of totp_secrets is instantly decryptable. Fail CLOSED at boot (mirrors
// the sender-cert / JWT_ACTION_SECRET pattern). Dev/test keep a fixed key
// so a local run without secrets still boots.
const DEV_TOTP_KEY = 'a'.repeat(64);
function totpEncryptionKey(): string {
  const key = process.env['TOTP_ENCRYPTION_KEY'] ?? '';
  if (key) return key;
  if (IS_PROD) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY must be set in production (64 hex chars) — ' +
      'refusing to boot with a default 2FA-at-rest encryption key',
    );
  }
  return DEV_TOTP_KEY;
}

// Audit Rev2 SEC-01 — JWT secrets must be REAL in production.
//
// These used to be `process.env[...] ?? ''`, and jwt.service.ts encoded that
// straight into an HMAC key. Signing and verifying HS256 with a zero-length key
// is self-consistent, so the service boots and serves traffic normally — while
// anyone who knows this forges {sub: <any user>, role: 'admin'}. The `?? ''`
// was a TypeScript reflex (config.get returns string|undefined; '' compiles),
// not a decision.
//
// Fail CLOSED at config load, mirroring totpEncryptionKey() above. This runs
// inside ConfigModule.forRoot({load:[configuration]}) — i.e. during
// NestFactory.create, before app.listen — so a misconfigured service refuses to
// START rather than 500-ing (or, via JwtAuthGuard's blanket catch, misleadingly
// 401-ing) on first request.
const DEV_ACCESS_SECRET = 'dev-only-access-secret-not-for-production-0123456789abcdef';
const DEV_ACTION_SECRET = 'dev-only-action-secret-not-for-production-0123456789abcdef';

// An emptiness check alone is not enough, twice over:
//   - infra/env/auth.env.example ships `<replace-with-output-of-openssl-rand-base64-64>`
//     and bootstrap-staging.sh copies it VERBATIM to /etc/bravo/auth.env. Not empty.
//   - docker-compose.yml publishes a 53-char dev secret with no angle brackets,
//     which sails past both a length rule and a placeholder rule.
const PUBLISHED_DEV_SECRETS = new Set([
  'dev-access-secret-do-not-use-in-prod-xxxxxxxxxxxxxxxx',
  DEV_ACCESS_SECRET,
  DEV_ACTION_SECRET,
]);

function jwtSecret(name: 'JWT_ACCESS_SECRET' | 'JWT_ACTION_SECRET', devFallback: string): string {
  const raw = process.env[name] ?? '';
  const s   = raw.trim();

  // 32 is a FLOOR on format, not a measure of entropy — it exists to catch
  // truncation and obvious junk. Keep it at 32: the messenger-service test
  // fixtures are 35 chars, and raising it to 64 would break them.
  const problem =
    !s                            ? 'missing or blank'
    : /^<.*>$/.test(s)            ? 'still the <replace-me> placeholder from auth.env.example'
    : s.length < 32               ? `too short (${s.length} chars, need at least 32)`
    : PUBLISHED_DEV_SECRETS.has(raw) ? 'a development secret published in this repository'
    : null;

  if (!problem) return raw;
  if (IS_PROD) {
    throw new Error(`${name} is ${problem} — refusing to start`);
  }
  return devFallback;
}

function jwtSecrets(): {accessSecret: string; actionSecret: string} {
  const accessSecret = jwtSecret('JWT_ACCESS_SECRET', DEV_ACCESS_SECRET);
  // NO `?? JWT_ACCESS_SECRET` fallback. It used to inherit, which meant a File
  // Vault MFA step-up token and an ordinary session token could be signed with
  // the same key — defeating the entire point of a step-up.
  const actionSecret = jwtSecret('JWT_ACTION_SECRET', DEV_ACTION_SECRET);
  if (accessSecret === actionSecret) {
    throw new Error(
      'JWT_ACTION_SECRET must differ from JWT_ACCESS_SECRET — a step-up proof signed ' +
      'with the session key proves nothing',
    );
  }
  // NOTE FOR DEPLOYS: auth-service only SIGNS action tokens; messenger-service
  // only VERIFIES them, with its own JWT_ACTION_SECRET and no fallback. The
  // binding requirement is therefore that this value is IDENTICAL on both
  // services — "present and distinct" is only half the contract.
  return {accessSecret, actionSecret};
}

export default () => ({
  port:        parseInt(process.env['PORT'] ?? '3001', 10),
  nodeEnv:     process.env['NODE_ENV'] ?? 'development',
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  redisUrl:    process.env['REDIS_URL'] ?? 'redis://127.0.0.1:7379',

  jwt: {
    ...jwtSecrets(),
    accessTtl:    process.env['JWT_ACCESS_TTL']  ?? '15m',
    refreshTtl:   process.env['JWT_REFRESH_TTL'] ?? '30d',
  },

  auth: {
    // Which second factor gates login/registration.
    //   'sms'  — Twilio Verify delivers a code (the original path).
    //   'totp' — RFC 6238 authenticator app; no SMS provider needed. The
    //            login response carries an enrolment payload (otpauth URI,
    //            manual key, backup codes) until the user has a VERIFIED seed.
    // Production with no Twilio credentials MUST run 'totp' — devFlag()
    // forces the OTP dev-bypass off there, so 'sms' without Twilio means
    // nobody can log in.
    secondFactor: (process.env['AUTH_SECOND_FACTOR'] ?? 'sms') === 'totp' ? 'totp' as const : 'sms' as const,
  },

  otp: {
    length:        parseInt(process.env['OTP_LENGTH'] ?? '6', 10),
    ttlMinutes:    parseInt(process.env['OTP_TTL_MINUTES'] ?? '10', 10),
    maxAttempts:   parseInt(process.env['OTP_MAX_ATTEMPTS'] ?? '3', 10),
    devReturnCode: devFlag(process.env['OTP_DEV_RETURN_CODE']),
    // DEV ONLY — when true, send() is a no-op (no Twilio) and check() always returns true.
    // Lets the full register/login flow work while Twilio is blocked or unavailable.
    // B-39: forced OFF in production regardless of the env var (see devFlag above).
    devBypass:     devFlag(process.env['OTP_DEV_BYPASS']),
  },

  twilio: {
    accountSid: process.env['TWILIO_ACCOUNT_SID'] ?? '',
    authToken:  process.env['TWILIO_AUTH_TOKEN']  ?? '',
    fromNumber: process.env['TWILIO_FROM']         ?? '',
    verifySid:  process.env['TWILIO_VERIFY_SID']   ?? '',  // Twilio Verify service SID (VA...)
  },

  totp: {
    // P1-P-1 — throws at boot in production when unset (see totpEncryptionKey).
    encryptionKey: totpEncryptionKey(),
    issuer:        process.env['TOTP_ISSUER'] ?? 'Bravo Secure',
  },

  kafka: {
    brokers:         (process.env['KAFKA_BROKERS'] ?? '').split(',').filter(Boolean),
    auditTopic:      process.env['KAFKA_AUDIT_TOPIC'] ?? 'audit-events',
    // BE-7.3 — geofence breach + escalation events land here for the
    // dispatch / pager surfaces that subscribe downstream.
    escalationTopic: process.env['KAFKA_ESCALATION_TOPIC'] ?? 'escalation-events',
  },

  biometric: {
    // B-39 hardening — same production guard as OTP; a biometric dev-bypass in
    // prod would defeat the Play Integrity / DeviceCheck gate.
    devBypass:      devFlag(process.env['BIOMETRIC_DEV_BYPASS']),
    googleApiKey:   process.env['GOOGLE_PLAY_INTEGRITY_KEY'] ?? '',
    androidPackage: process.env['ANDROID_PACKAGE_NAME'] ?? 'com.bravosecure',
    appleTeamId:    process.env['APPLE_TEAM_ID'] ?? '',
    appleKeyId:     process.env['APPLE_DEVICE_CHECK_KEY_ID'] ?? '',
    appleP8Key:     process.env['APPLE_DEVICE_CHECK_P8_KEY'] ?? '',
    appleDevMode:   process.env['NODE_ENV'] !== 'production',
  },

  rateLimit: {
    authPerHour: parseInt(process.env['RATE_LIMIT_AUTH_PER_HOUR'] ?? '5', 10),
  },

  senderCert: {
    issuer:         process.env['SENDER_CERT_ISSUER'] ?? 'auth-service',
    /** 24h default per Phase-1 WBS (BE-2.2). Short enough that revocation urgency is bounded, long enough to survive cert refresh hiccups. */
    ttlSeconds:     parseInt(process.env['SENDER_CERT_TTL_SECONDS'] ?? '86400', 10),
    /** 32-byte Curve25519 private key, base64. Generated once via the keypair script and stored in .env (never committed). */
    privateKeyB64:  process.env['SENDER_CERT_PRIVATE_KEY_B64'] ?? '',
  },

  stripe: {
    // Secret key is server-side only. Empty => /wallet/topup runs in
    // "fallback" mode that still issues BC locally (no PaymentIntent).
    secretKey:       process.env['STRIPE_SECRET_KEY'] ?? '',
    webhookSecret:   process.env['STRIPE_WEBHOOK_SECRET'] ?? '',
    // BRAVO_CREDITS_PER_USD removed 2026-07-05 (CREDITS_BC_AUDIT F-02): the peg
    // is hard-coded at 1 fiat unit = 1 BC in WalletService.computeCreditsForFiat.
    /** Stripe Price ids for the auto-renewing paid tiers. Empty
     *  => auto-renew unavailable for that tier; manual BC subscribe still works. */
    proPriceId:        process.env['STRIPE_PRO_PRICE_ID'] ?? '',
    enterprisePriceId: process.env['STRIPE_ENTERPRISE_PRICE_ID'] ?? '',
    apiBase:         process.env['STRIPE_API_BASE'] ?? 'https://api.stripe.com',
    apiVersion:      process.env['STRIPE_API_VERSION'] ?? '2024-06-20',
  },

  telemetry: {
    /** Max length per Redis Stream (XADD MAXLEN ~). Keeps ~50min of 6-sec fixes. */
    streamMaxLen:    parseInt(process.env['TELEMETRY_STREAM_MAXLEN'] ?? '500', 10),
    /** TTL on the entire stream key once the mission completes. */
    streamTtlSec:    parseInt(process.env['TELEMETRY_STREAM_TTL_SEC'] ?? '86400', 10),
  },

  featureFlags: {
    // Auto-dispatch (Uber-style nearest-agency matching). Default OFF so the
    // legacy admin-mediated booking flow (POST /bookings -> PENDING_OPS) stays
    // byte-for-byte unchanged while the feature ships dark. The booking
    // create() branch that reads this flag lands in a later step.
    autoDispatch: process.env['AUTO_DISPATCH_ENABLED'] === 'true',
    // Department Chat v2 (provider↔CPO attendance verification + structured
    // incident reporting). Default OFF so the legacy /attendance/* surface and
    // the existing department chat stay byte-for-byte unchanged while the module
    // ships dark. New controllers/routes 404/no-op when false; read via
    // ConfigService.get('featureFlags.deptChatV2'). Flipped per-org at rollout
    // (Step 17) — the flag gates the FEATURE only, never a security guard.
    deptChatV2: process.env['DEPT_CHAT_V2_ENABLED'] === 'true',
  },

  // Fixed platform wallet accounts for the auto-dispatch escrow flow (Step 3).
  // Plain wallet_balances rows seeded by 20260620000002_escrow_integrity.sql —
  // these literals MUST match that migration (a unit test guards the drift).
  // Deterministic system ids, NOT env-driven; distinct from
  // SystemMessengerService.SYSTEM_USER_ID (…0001) so escrow money never lands
  // on the messenger system actor.
  platformAccounts: {
    escrowId:      '00000000-0000-0000-0000-0000000000e5',
    platformFeeId: '00000000-0000-0000-0000-0000000000fe',
  },

  // Auto-dispatch completion gate + dispute-window tunables (Step 10 §40). The
  // proof-of-completion gate reads these to decide PENDING_RELEASE vs review_required.
  dispatch: {
    /** A GPS fix this close to pickup counts as "reached pickup" (meters). */
    arrivalRadiusM:       parseInt(process.env['DISPATCH_ARRIVAL_RADIUS_M'] ?? '150', 10),
    /** Min GPS pings during LIVE to count as real telemetry coverage (not a 30s "live"). */
    minPings:             parseInt(process.env['DISPATCH_MIN_PINGS'] ?? '5', 10),
    /** Min LIVE duration (seconds) for a completion to count as genuine on-task time. */
    minOnTaskSeconds:     parseInt(process.env['DISPATCH_MIN_ONTASK_SECONDS'] ?? '300', 10),
    /** Default dispute window (seconds) from completion to auto-release eligibility. */
    disputeWindowSeconds: parseInt(process.env['DISPATCH_DISPUTE_WINDOW_SECONDS'] ?? '259200', 10), // 72h
    /** Platform's cut of the gross at release, in percent (0 = agency keeps all).
     *  Interim default 15% (founder: "set some for now, ops will tune it on the
     *  console"). SAFE to default because the whole auto-dispatch escrow path is
     *  dark until AUTO_DISPATCH_ENABLED is flipped, so nothing is charged yet.
     *  env DISPATCH_PLATFORM_FEE_PCT overrides; the ops-console fee control that
     *  writes a DB-backed value is the pending follow-up. */
    platformFeePct:       parseInt(process.env['DISPATCH_PLATFORM_FEE_PCT'] ?? '15', 10),
    /** Cancellation fee paid to the agency when a client cancels AFTER crew was
     *  committed (a mission exists), in percent of gross (0 = full refund).
     *  Interim default 25% — same dark-path safety + ops-console tuning as above.
     *  ⚠️ When this goes live, exercise the post-crew cancel split path on a device
     *  first (it has never run with a non-zero fee). */
    cancelFeePct:         parseInt(process.env['DISPATCH_CANCEL_FEE_PCT'] ?? '25', 10),
    /** Step 16 — minutes from crew-assign by which the assigned crew must reach
     *  PICKUP. Past this the arrival-no-show watchdog re-dispatches the booking to
     *  another agency (the escrow hold persists; the client is never re-charged). */
    arrivalSlaMinutes:    parseInt(process.env['DISPATCH_ARRIVAL_SLA_MINUTES'] ?? '20', 10),
    /** FRAUD-2 / P0 — when true, proof-of-completion check 5 REQUIRES a
     *  server-verified guard-identity handshake (missions.identity_verified_at)
     *  before a completion may auto-release escrow; without it the hold goes to
     *  review_required (ops can release/refund via the §41 path). Ships DARK
     *  (default false) so it cannot strand escrow before the mobile handshake
     *  UI is live on BOTH the client (shows arrival_code) and the guard (enters
     *  it); flip DISPATCH_REQUIRE_IDENTITY_HANDSHAKE=true once that ships. */
    requireIdentityHandshake: process.env['DISPATCH_REQUIRE_IDENTITY_HANDSHAKE'] === 'true',
    /** FRAUD-1 — when true, proof-of-completion also requires the LIVE telemetry
     *  to show real spatial spread (a lead can't pass by posting N identical
     *  fabricated fixes at the pickup point). Below minLiveMovementM of spread
     *  the hold goes to review_required. Ships DARK (default false): a genuinely
     *  stationary detail would trip it, so tune minLiveMovementM against real
     *  missions before flipping DISPATCH_REQUIRE_LIVE_MOVEMENT=true. */
    requireLiveMovement: process.env['DISPATCH_REQUIRE_LIVE_MOVEMENT'] === 'true',
    /** Min bounding-box spread (meters) of the LIVE telemetry to count as movement. */
    minLiveMovementM:     parseInt(process.env['DISPATCH_MIN_LIVE_MOVEMENT_M'] ?? '25', 10),
  },

  // Client booking policy.
  booking: {
    /** Hours after creation during which the CLIENT may self-cancel a booking.
     *  After this window the booking is locked (ops can still cancel). Default 1h. */
    cancelWindowHours: parseFloat(process.env['BOOKING_CANCEL_WINDOW_HOURS'] ?? '1'),
    /** Step 16 — E.164 hotline surfaced on the NO_PROVIDER fallback card so a client
     *  stranded with no available agency can reach a human. Empty => card hides it. */
    hotlineE164: process.env['BOOKING_HOTLINE_E164'] ?? '',
  },

  // FX rate table — UNITS of fiat per 1 USD, used to convert a fiat top-up/charge
  // into Bravo Credits (computeCreditsForFiat) and to stamp the rate onto each money
  // row's metadata. Pegged currencies (aed/sar) are exact; eur/gbp are the inverse of
  // the USD-per-unit market rate. Regions are AE/SA/BD/GB + the usd/eur base (D4).
  // ⚠️ ALL non-USD rates are DEMO PLACEHOLDERS — a finance/CFO-signed table is required
  // before cut-over. Env-overridable so finance sets the signed rates without a deploy.
  fx: {
    usd: parseFloat(process.env['FX_UNITS_PER_USD_USD'] ?? '1'),
    aed: parseFloat(process.env['FX_UNITS_PER_USD_AED'] ?? '3.67'),
    eur: parseFloat(process.env['FX_UNITS_PER_USD_EUR'] ?? '0.9259259259'), // 1/1.08
    sar: parseFloat(process.env['FX_UNITS_PER_USD_SAR'] ?? '3.75'),
    gbp: parseFloat(process.env['FX_UNITS_PER_USD_GBP'] ?? '0.7874015748'), // 1/1.27
    bdt: parseFloat(process.env['FX_UNITS_PER_USD_BDT'] ?? '110'),
  },

  // F1 — per-region VAT/tax percent BROKEN OUT of the (tax-inclusive) credit
  // total on invoices. ⚠️ Ships 0 everywhere until finance signs real rates
  // (expected first entries: AE 5, GB 20). Env-overridable per region.
  regionTaxPct: {
    AE: parseFloat(process.env['TAX_PCT_AE'] ?? '0'),
    SA: parseFloat(process.env['TAX_PCT_SA'] ?? '0'),
    BD: parseFloat(process.env['TAX_PCT_BD'] ?? '0'),
    GB: parseFloat(process.env['TAX_PCT_GB'] ?? '0'),
    ZA: parseFloat(process.env['TAX_PCT_ZA'] ?? '0'),
  },
});
