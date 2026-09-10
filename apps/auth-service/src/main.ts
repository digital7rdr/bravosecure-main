import 'reflect-metadata';
import {NestFactory}          from '@nestjs/core';
import {ValidationPipe}       from '@nestjs/common';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {AppModule}            from './app.module';
import {join}                 from 'node:path';
import {mkdirSync}            from 'node:fs';

async function bootstrap(): Promise<void> {
  // INFRA-1 — last-resort process guards. Every Redis-locked sweep ticks as
  // `void this.sweepOnce()` and awaits its lock acquisition OUTSIDE a try, so
  // a transient Redis outage rejects unhandled → Node's default terminates the
  // process → systemd Restart=always crash-loops the WHOLE service (auth,
  // bookings, SOS) for the duration of the blip. `payment-pending-expiry` is
  // not flag-gated, so this is reachable on every deploy. These handlers
  // convert an unhandled rejection / uncaught throw into a logged event and
  // keep the process alive; the per-sweep `.catch` guards below them are the
  // primary containment (each sweep re-checks state under a DB lock, so a
  // skipped tick is safe). Do NOT remove without restoring both.
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[auth-service] unhandledRejection (kept alive):', reason);
  });
  process.on('uncaughtException', (err: unknown) => {
    console.error('[auth-service] uncaughtException (kept alive):', err);
  });

  // Auth audit P0-A9 — refuse to start in production with any of the
  // OTP / biometric dev-bypass envs set. Those flags exist for local
  // development (e.g. let the OTP code be `123456` so emulator tests
  // run without Twilio). A typo in a Helm chart or a stale `.env`
  // rsync'd to prod silently flips the entire OTP + biometric gate
  // off; the only signal today is a `logger.warn` line nobody
  // monitors. Fail-fast here matches the pattern already in place
  // for `CORS_ALLOWED_ORIGINS` below.
  if (process.env.NODE_ENV === 'production') {
    const dangerous = [
      'OTP_DEV_BYPASS',
      'BIOMETRIC_DEV_BYPASS',
      'OTP_DEV_RETURN_CODE',
      'DISPATCH_TRUST_MOCKED_LOCATION',
      'DISPATCH_DISABLE_REGION_FILTER',
    ];
    const enabled = dangerous.filter(k => process.env[k] === 'true');
    if (enabled.length > 0) {
      throw new Error(
        `refusing_to_start: dev bypass flags set in production: ${enabled.join(', ')}`,
      );
    }
    // INFRA-15 — the Stripe-less top-up fallback MINTS free credits (wallet.service
    // topUp). It exists for dev/staging; in production it is a free-credit printer, so
    // fail fast (its own env value is '1', not 'true', hence the separate check).
    if (process.env.ALLOW_NO_STRIPE_TOPUP === '1') {
      throw new Error('refusing_to_start: ALLOW_NO_STRIPE_TOPUP=1 (free-credit top-up) set in production');
    }
    // INFRA-9 — the dispatch SLO evaluator + money-drift reconciliation page through Sentry.
    // With no DSN those pages are SILENT (a dead payout sweep / money drift goes unnoticed),
    // so warn LOUD at boot. Not fatal — Sentry is optional — but it must be visible.
    if (!process.env.SENTRY_DSN) {
      console.warn('[auth-service] WARNING: SENTRY_DSN is not set in production — dispatch SLO and money-drift alerts are SILENT.');
    }
    // The agent/KYC upload endpoint builds file_url from PUBLIC_BASE_URL and falls back
    // to http://localhost:3001 — a broken, insecure URL if this is unset in prod. Warn
    // loud at boot so the misconfig is caught at deploy, not in a client that can't load
    // the file. Not fatal (a redeploy with the env set fixes it without a code change).
    if (!process.env.PUBLIC_BASE_URL) {
      console.warn('[auth-service] WARNING: PUBLIC_BASE_URL is not set in production — upload file_url will fall back to http://localhost:3001 (broken links).');
    }
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
    // Stripe webhook needs the raw bytes to verify the HMAC signature.
    // Nest v10 exposes req.rawBody when this flag is set.
    rawBody: true,
  });

  // Global validation — strip unknown properties, transform types.
  // Audit fix 1.4 — forbidNonWhitelisted rejects extra fields (catches
  // typos AND attempts to smuggle privileged fields like `role` /
  // `subscription_tier` into endpoints whose DTOs don't accept them).
  //
  // Rolled out staged via STRICT_VALIDATION env: `true` in staging (and
  // any dev shell that opts in) returns 400 on unknown fields; default /
  // `false` keeps the old whitelist-and-strip behavior so an in-flight
  // mobile build sending a stale field doesn't suddenly start failing
  // in prod. Flip to `true` in prod only after the canary confirms no
  // 400 spike on /auth/*, /bookings/*, /ops/*.
  const strictValidation = process.env.STRICT_VALIDATION === 'true';
  app.useGlobalPipes(new ValidationPipe({
    whitelist:            true,
    forbidNonWhitelisted: strictValidation,
    transform:            true,
  }));

  // Audit Rev2 API-01 prerequisite — trust EXACTLY ONE proxy hop, not "any".
  //
  // `true` means "trust every hop", so Express's proxy-addr never truncates the
  // chain and `req.ip` becomes the LEFTMOST value of the client-supplied
  // X-Forwarded-For header. Nothing strips an inbound XFF, so a caller can mint
  // a brand-new rate-limit bucket on every request simply by varying it — which
  // would make the throttler a control that reads correctly and enforces
  // nothing. They can also pin a victim's IP to exhaust the victim's bucket,
  // and every ops_audit row records an attacker-chosen address.
  //
  // 1 = trust only the hop immediately in front of us (the LB/reverse proxy),
  // so req.ip is the address that proxy actually saw. If another proxy is ever
  // added in front, RAISE THIS TO MATCH THE HOP COUNT — do not set it back to
  // `true`, or the spoof returns.
  app.set('trust proxy', parseInt(process.env['TRUST_PROXY_HOPS'] ?? '1', 10));

  // Audit fix 0.4 — minimal cookie parser. Avoids adding `cookie-parser`
  // as a dep just to read 1-2 cookies. Express 4 doesn't expose req.cookies
  // by default. Skips CORS preflights (no cookies travel on OPTIONS) and
  // tolerates malformed `%`-sequences — without the try/catch, an attacker
  // who plants `bravo_ops_token=%XX` via a cross-site <img> would crash
  // every subsequent request through this middleware.
  app.use((req: Express.Request & {cookies?: Record<string, string>}, _res: unknown, next: () => void) => {
    const method = (req as unknown as {method?: string}).method;
    if (method === 'OPTIONS') {
      req.cookies = {};
      return next();
    }
    const header = (req as unknown as {headers: Record<string, string | undefined>}).headers.cookie;
    const out: Record<string, string> = {};
    if (typeof header === 'string') {
      for (const pair of header.split(';')) {
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (!k) continue;
        try {
          out[k] = decodeURIComponent(v);
        } catch {
          // Malformed percent-encoding — keep the raw value rather than
          // throwing and 500'ing the request. Downstream guards compare
          // cookie equality, so a corrupt value just fails the check.
          out[k] = v;
        }
      }
    }
    req.cookies = out;
    next();
  });

  // Audit fix 0.4 + 1.6 — explicit CORS origin allowlist.
  //
  // The previous default (`origin: true`) reflected back any Origin header,
  // which combined with `credentials: true` is the well-known footgun: an
  // attacker page on evil.com can ride along on the user's session via
  // CORS-with-credentials. We now refuse the request unless the Origin is
  // in the configured list.
  //
  // CORS_ALLOWED_ORIGINS is a comma-separated env var of allowed origins,
  // e.g. "https://ops.bravosecure.com,https://app.bravosecure.com".
  // In dev it can be left empty or set to "*" to fall back to non-credentialed
  // wildcard mode (origin reflection is still disabled in that branch — the
  // browser sees `Access-Control-Allow-Origin: *` only when not sending
  // credentials, so the cookie session won't work but a Bearer-token client
  // — i.e. mobile — still does).
  const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const wildcard = corsOrigins.includes('*');
  if (corsOrigins.length === 0 && process.env.NODE_ENV === 'production') {
    // Fail-closed in prod — refusing to start beats silently allowing
    // every origin. A misconfigured deploy never reaches the CSRF gate.
    throw new Error('CORS_ALLOWED_ORIGINS must be set in production');
  }
  // Which second factor gates login. In production, 'sms' with no Twilio
  // credentials is a silent lock-out: devFlag() has already forced the OTP
  // dev-bypass off, so every login would die at otp.send(). Refuse to start
  // rather than ship an auth service nobody can pass.
  const secondFactor = process.env.AUTH_SECOND_FACTOR === 'totp' ? 'totp' : 'sms';
  if (process.env.NODE_ENV === 'production' && secondFactor === 'sms'
      && !(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SID)) {
    throw new Error('refusing_to_start: AUTH_SECOND_FACTOR=sms in production but Twilio Verify is not configured — set AUTH_SECOND_FACTOR=totp or supply TWILIO_ACCOUNT_SID/AUTH_TOKEN/VERIFY_SID');
  }
  console.log(`[auth-service] second factor: ${secondFactor}`);

  app.enableCors({
    origin:         wildcard ? '*' : (corsOrigins.length > 0 ? corsOrigins : false),
    credentials:    !wildcard,    // wildcard + credentials is rejected by browsers
    exposedHeaders: ['X-CSRF-Token'],
  });

  // Serve uploaded files (KYC + compliance-pack docs) so the ops-console
  // can render <a href="http://host:3001/uploads/…"> links.
  const uploadsDir = join(process.cwd(), 'uploads');
  mkdirSync(uploadsDir, {recursive: true});
  app.useStaticAssets(uploadsDir, {prefix: '/uploads/'});

  // Step 26 — run onModuleDestroy on SIGTERM so the Redis-locked watchdog/SLO/
  // reconciliation sweeps clear their timers cleanly on a rolling deploy.
  app.enableShutdownHooks();

  const port = process.env['PORT'] ?? 3001;
  await app.listen(port, '0.0.0.0');
  console.log(
    `[auth-service] Listening on :${port} ` +
    `(strict_validation=${strictValidation}, cors_origins=${wildcard ? '*' : corsOrigins.join(',') || 'none'})`,
  );
}

void bootstrap();
