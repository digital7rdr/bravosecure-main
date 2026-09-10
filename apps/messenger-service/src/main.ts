import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import {ConfigService} from '@nestjs/config';
import {ValidationPipe} from '@nestjs/common';
import type {NestExpressApplication} from '@nestjs/platform-express';
import helmet from 'helmet';
import {AppModule} from './app.module';
import {RedisIoAdapter} from './gateway/redis-io.adapter';

/**
 * Messenger-service entry point.
 *
 * Serves:
 *  - HTTP on PORT (default 3100) — REST endpoints + `/healthz`.
 *  - socket.io handshake at `/ws` on the same port.
 *
 * Transport: socket.io (4.x) with the `@socket.io/redis-adapter` pub/sub
 * attached so `server.to(room).emit(...)` fans out across every replica.
 * Clients speak socket.io-client over a pure WebSocket transport (no
 * long-polling) — mobile networks handle the upgrade fine and it keeps
 * the wire lean.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
    // H-10 — disable Nest's built-in body parser so we can register one
    // with a raised limit below. Without this, the default 100 KB json
    // parser stays first in the chain and 413s a legitimate large
    // payload (PutSessionsDto.blob allows 16 MB; message ciphertext up
    // to 800 KB base64) BEFORE the ValidationPipe ever runs.
    bodyParser: false,
  });

  const config = app.get(ConfigService);

  // Why: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY both default to '' in
  // configuration.ts, and BackupService + UserPrivacyService respond to a
  // missing value by logging `backup.disabled` / `privacy.disabled` ONCE and
  // running on. In production that turns a misconfigured deploy into a silent
  // loss of message backup and privacy enforcement that no health check sees.
  // Fail closed at boot instead — same posture as CORS_ORIGINS below and
  // SFU_ROOM_TOKEN_SECRET. Dev and test keep the degraded mode.
  if (process.env.NODE_ENV === 'production') {
    const missing = (['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const)
      .filter((k) => !(config.get<string>(
        k === 'SUPABASE_URL' ? 'backup.supabaseUrl' : 'backup.supabaseServiceRoleKey',
      ) ?? '').trim());
    if (missing.length > 0) {
      throw new Error(
        `[messenger-service] refusing to boot: ${missing.join(' and ')} ` +
        'not set with NODE_ENV=production. Backup and privacy enforcement ' +
        'would silently disable. Set them, or run with NODE_ENV!=production.',
      );
    }
  }

  const redisUrl     = config.get<string>('redis.url')            ?? 'redis://127.0.0.1:6379';
  const heartbeatMs  = config.get<number>('ws.heartbeatMs')       ?? 30_000;
  const heartbeatGr  = config.get<number>('ws.heartbeatGrace')    ?? 25_000;
  const maxPayloadB  = config.get<number>('ws.maxPayloadBytes')   ?? 256 * 1024;
  const wsRecovery   = config.get<boolean>('ws.sessionRecovery')  ?? false;

  // Audit Transport P0-4 — share the HTTP CORS allowlist with the WS
  // adapter so a browser can't connect to /ws from an unlisted origin
  // using a stolen ops-console JWT. Empty list = dev fallback to
  // localhost-only (mirrors the HTTP enableCors below).
  const wsAllowedOrigins = (config.get<string>('cors.origins') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const adapter = new RedisIoAdapter(app, redisUrl, heartbeatMs, heartbeatGr, maxPayloadB, wsAllowedOrigins, wsRecovery);
  await adapter.connectToRedis();
  app.useWebSocketAdapter(adapter);
  app.enableShutdownHooks();

  app.set('trust proxy', true);

  // Audit P3 (no helmet) — standard security headers on the HTTP surface.
  // CSP is disabled: this service serves JSON + the socket.io handshake
  // only (no HTML/assets), so a CSP adds nothing here and a default-src
  // policy could interfere with socket.io's polling fallback responses.
  // COEP is disabled for the same reason (API responses are fetched
  // cross-origin by the ops console under the CORS allowlist below).
  // The WS upgrade itself is untouched — helmet only stamps response
  // headers on HTTP requests.
  app.use(helmet({
    contentSecurityPolicy:     false,
    crossOriginEmbedderPolicy: false,
  }));

  // H-10 — body-parser limits sized to the largest DTO cap. The identity
  // sessions blob (PutSessionsDto) allows 16 MB; 20 MB gives headroom for
  // base64 + JSON envelope overhead. Applies to every HTTP route (the WS
  // path is unaffected). urlencoded is raised too although the API is
  // JSON-only, so a stray form post isn't silently 413'd at 100 KB.
  app.useBodyParser('json', {limit: '20mb'});
  app.useBodyParser('urlencoded', {limit: '20mb', extended: true});

  // Round 7 / security audit fix S1 — register the global ValidationPipe.
  // Without this every `class-validator` decorator on every DTO
  // (@IsString, @MaxLength, @ValidateNested, @Matches, etc.) is a
  // no-op at runtime — the controllers accept any-shaped JSON and the
  // hand-coded byte-length checks were the only line of defence. With
  // this pipe in place, malformed requests are rejected with 400
  // before they reach a handler.
  //   whitelist:                strip unknown properties
  //   forbidNonWhitelisted:      reject extras with 400 (defence-in-depth)
  //   transform:                 instantiate DTO classes (needed for nested @ValidateNested)
  //   transformOptions.enableImplicitConversion: false (don't string→number coerce silently)
  app.useGlobalPipes(new ValidationPipe({
    whitelist:             true,
    forbidNonWhitelisted:  true,
    transform:             true,
    transformOptions:      {enableImplicitConversion: false},
  }));

  // Round 7 / security audit fix S6 — replace the wildcard CORS reflect
  // (`origin: true`) with an explicit allowlist sourced from config.
  // Wildcard + credentials let any origin call us with the user's
  // session cookie, opening cross-origin abuse against the ops console
  // (cookie-bearing) and any future browser-based webclient.
  const allowedOrigins = (config.get<string>('cors.origins') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowedOrigins.length === 0) {
    // Dev-only fallback: reflect the request origin for localhost. In
    // production CORS_ORIGINS must be set or no browser can talk to us.
    app.enableCors({
      origin: (origin, cb) => {
        if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          return cb(null, true);
        }
        return cb(new Error('cors_blocked'));
      },
      credentials: true,
    });
  } else {
    app.enableCors({origin: allowedOrigins, credentials: true});
  }

  // Audit P2-P-1 — /healthz is now FUNCTIONAL, not liveness-only. The
  // Dockerfile HEALTHCHECK probes this endpoint; a zombie process that
  // lost Redis or whose SFU worker pool emptied (every worker died and
  // the restart budget gave up) used to keep answering 200 and was never
  // recycled. Verifies:
  //   - Redis answers PING (hard gate — every stateful op needs it)
  //   - the mediasoup worker pool is non-empty when the SFU plane loaded
  // Returns 503 on failure so the container healthcheck flips unhealthy.
  {
    const {RedisService} = require('./redis/redis.service') as typeof import('./redis/redis.service');
    const {SfuWorkerPool} = require('./sfu/sfuWorkerPool') as typeof import('./sfu/sfuWorkerPool');
    const redis = app.get(RedisService, {strict: false});
    const sfuPool = app.get(SfuWorkerPool, {strict: false});
    app.getHttpAdapter().get('/healthz', async (_req: unknown, res: {status: (n: number) => {json: (b: unknown) => void}}) => {
      let redisOk = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        redisOk = (await Promise.race([
          redis.client.ping(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('ping_timeout')), 1_500);
          }),
        ])) === 'PONG';
      } catch {
        redisOk = false;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const sfuWorkers = sfuPool ? sfuPool.stats().workers : -1;
      // Why: sfuPool unresolved (-1) means the SFU plane isn't wired in
      // this build — that's "not enabled", not "dead"; only an EMPTY
      // pool on a loaded plane is a zombie.
      const sfuOk = sfuWorkers !== 0;
      const ok = redisOk && sfuOk;
      res.status(ok ? 200 : 503).json({
        ok,
        service:    'messenger-service',
        redis:      redisOk ? 'ok' : 'down',
        sfuWorkers,
        now:        new Date().toISOString(),
      });
    });
  }

  // Audit HIGH-3 (2026-07-02): READINESS probe — reports NOT-ready (503) when
  // this pod has lost its Redis connection, so the load balancer drains it
  // instead of routing sockets/requests that would fail on every stateful op.
  // Distinct from /healthz so the orchestrator restarts a truly-dead process
  // but merely stops sending traffic to a Redis-partitioned one.
  {
    const {RedisService} = require('./redis/redis.service') as typeof import('./redis/redis.service');
    const {BackupService} = require('./backup/backup.service') as typeof import('./backup/backup.service');
    const redis = app.get(RedisService, {strict: false});
    const backup = app.get(BackupService, {strict: false});
    app.getHttpAdapter().get('/ready', (_req: unknown, res: {status: (n: number) => {json: (b: unknown) => void}}) => {
      const ready = !!redis?.isReady;
      // L-5 — surface the sealed_envelope_archive probe result. Redis is
      // the only HARD readiness gate (a Redis-partitioned pod can't serve
      // stateful ops → drain it). A missing archive table is DEGRADED,
      // not dead: reported for observability but does NOT flip 503, since
      // that would drain the whole fleet if a migration lagged a deploy.
      const archive = backup?.isArchiveAvailable?.() ? 'ok' : 'degraded';
      res.status(ready ? 200 : 503).json({ready, redis: redis?.isReady ? 'ready' : 'down', archive});
    });
  }

  const port = process.env['PORT'] ?? 3100;
  await app.listen(port, '0.0.0.0');
  console.log(`[messenger-service] Listening on :${port} (socket.io at /ws, redis-adapter attached)`);
}

// B-05 — a single unhandled throw/rejection (e.g. inside one socket handler)
// used to crash the whole process and drop EVERY live WS at once (15/15 calls
// killed in QA). Log and KEEP SERVING so one bad event can't take down every
// connection. Boot failures, by contrast, must exit non-zero so the supervisor
// restarts rather than running a half-initialised server.
//
// Audit P2-P-1 — but swallow-ALL defangs `restart: unless-stopped`, which only
// acts on process EXIT: a process throwing uncaughtExceptions in a loop is
// functionally dead yet never recycled. Track a sliding window; past the
// threshold the process is not "one bad event" but a corrupt state, so exit
// non-zero and let docker's restart policy hand out a clean slate.
const FATAL_WINDOW_MS  = 60_000;
const FATAL_THRESHOLD  = 5;
const fatalTimestamps: number[] = [];
function trackFatal(): void {
  const now = Date.now();
  fatalTimestamps.push(now);
  while (fatalTimestamps.length > 0 && now - fatalTimestamps[0] > FATAL_WINDOW_MS) {
    fatalTimestamps.shift();
  }
  if (fatalTimestamps.length >= FATAL_THRESHOLD) {
    console.error(
      `[messenger-service] ${fatalTimestamps.length} uncaughtExceptions in ${FATAL_WINDOW_MS / 1000}s — ` +
      'process state is unreliable, exiting for supervisor restart',
    );
    process.exit(1);
  }
}
process.on('uncaughtException', (err) => {
  console.error('[messenger-service] uncaughtException (kept alive)', err);
  trackFatal();
});
process.on('unhandledRejection', (reason) => {
  console.error('[messenger-service] unhandledRejection (kept alive)', reason);
});

bootstrap().catch((err) => {
  console.error('[messenger-service] bootstrap failed', err);
  process.exit(1);
});
