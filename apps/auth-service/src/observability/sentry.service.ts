import {Injectable, Logger, OnModuleInit} from '@nestjs/common';

/**
 * Audit fix 5.4 — observability shim.
 *
 * Wraps `@sentry/node` so the rest of the code can call
 * `captureException` / `addBreadcrumb` without importing Sentry
 * directly. If the package is absent (CI without DSN, local dev,
 * minimal containers) the shim falls back to no-op + a single boot
 * log line so misconfig is obvious in `docker logs`.
 *
 * Why a shim instead of @sentry/node + DSN env-only:
 *   - DSN absence shouldn't break boot or require an env stub.
 *   - The Sentry SDK loads slowly; loading lazily keeps cold-start
 *     latency low for the test runners.
 *   - Future swap to OpenTelemetry-only doesn't require touching
 *     call sites.
 *
 * Operational wiring (deploy-time):
 *   1. `npm install --workspace=apps/auth-service @sentry/node`
 *   2. set `SENTRY_DSN` in the prod environment
 *   3. Restart the service; the boot log line will flip from
 *      "sentry: disabled (no DSN)" to "sentry: enabled".
 */
type SentryLike = {
  init: (opts: {dsn: string; environment?: string; tracesSampleRate?: number}) => void;
  captureException: (e: unknown, ctx?: Record<string, unknown>) => void;
  addBreadcrumb: (b: {category?: string; message?: string; data?: Record<string, unknown>; level?: 'info' | 'warning' | 'error'}) => void;
  setUser?: (u: {id?: string; role?: string} | null) => void;
};

@Injectable()
export class SentryService implements OnModuleInit {
  private readonly log = new Logger(SentryService.name);
  private sdk: SentryLike | null = null;
  private enabled = false;

  async onModuleInit(): Promise<void> {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
      this.log.log('sentry: disabled (no SENTRY_DSN)');
      return;
    }
    try {
      // Dynamic require so the SDK is optional. If it's not installed
      // we log once and stay disabled — auth-service still boots.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk: SentryLike = require('@sentry/node');
      sdk.init({
        dsn,
        environment: process.env.NODE_ENV ?? 'development',
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.05'),
      });
      this.sdk = sdk;
      this.enabled = true;
      this.log.log(`sentry: enabled env=${process.env.NODE_ENV ?? 'development'}`);
    } catch (e) {
      this.log.warn(`sentry: install missing — running without it (${(e as Error).message})`);
    }
  }

  /**
   * Audit fix 5.4 — fail-closed audit insert alert.
   *
   * Phase 2.1 makes critical-action audit writes fail-closed (the
   * caller's transaction rolls back if the audit row can't land).
   * That throws an error; this is the receiver that decides what to
   * do with it. Sentry gets the exception with a `kind` tag so the
   * audit-failure alert rule can fire without paging on every random
   * 500.
   */
  reportCriticalAuditFailure(action: string, subject: string, err: Error): void {
    this.log.error(`audit.critical_failure action=${action} subject=${subject} msg=${err.message}`);
    if (this.enabled && this.sdk) {
      try {
        this.sdk.captureException(err, {
          tags: {kind: 'audit_critical_failure', action} as Record<string, unknown>,
          extra: {subject},
        } as Record<string, unknown>);
      } catch (e) {
        this.log.warn(`sentry capture failed: ${(e as Error).message}`);
      }
    }
  }

  captureException(e: unknown, ctx?: Record<string, unknown>): void {
    if (this.enabled && this.sdk) {
      try { this.sdk.captureException(e, ctx); } catch (cbErr) {
        this.log.warn(`sentry capture failed: ${(cbErr as Error).message}`);
      }
    }
  }

  /**
   * Audit fix 5.4 — Sentry breadcrumb for ops decisions.
   *
   * Use at the call site of approve/reject/dispatch/complete/abort so a
   * later exception report includes the chain of ops actions leading up
   * to it. Non-sensitive payload only (no PII, no message bodies).
   */
  opsDecisionBreadcrumb(action: string, admin: {call_sign?: string; role?: string} | undefined, subject: {type: string; id: string}): void {
    if (!this.enabled || !this.sdk) return;
    try {
      this.sdk.addBreadcrumb({
        category: 'ops.decision',
        message:  `${action} on ${subject.type}:${subject.id}`,
        level:    'info',
        data: {
          admin_call: admin?.call_sign ?? null,
          admin_role: admin?.role ?? null,
          subject:    `${subject.type}:${subject.id}`,
        },
      });
    } catch (e) {
      this.log.warn(`sentry breadcrumb failed: ${(e as Error).message}`);
    }
  }

  get isEnabled(): boolean { return this.enabled; }
}
