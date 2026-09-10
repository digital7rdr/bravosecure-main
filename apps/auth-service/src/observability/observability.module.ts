import {Module, Global} from '@nestjs/common';
import {SentryService} from './sentry.service';
import {DispatchMetricsService} from './dispatch-metrics.service';
import {HealthController} from './health.controller';

/**
 * Audit fix 5.4 — globally available SentryService + the Step-26 dispatch metric registry.
 *
 * @Global so any service can inject without each module importing the shim. SentryService
 * self-disables when `SENTRY_DSN` is unset; DispatchMetricsService is a process-local
 * counter/gauge/histogram store read by /metrics + /ready + the SLO evaluator. The
 * HealthController exposes the PUBLIC /health, /ready and /metrics endpoints.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [SentryService, DispatchMetricsService],
  exports:   [SentryService, DispatchMetricsService],
})
export class ObservabilityModule {}
