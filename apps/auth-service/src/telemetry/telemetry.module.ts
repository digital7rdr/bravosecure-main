import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {TelemetryService} from './telemetry.service';
import {TelemetryController} from './telemetry.controller';

/**
 * Telemetry module — Redis Stream-backed GPS ingest for missions.
 *
 * Evolution path:
 *   - Phase 2 adds a WebSocket gateway under `/ws/telemetry` that consumes
 *     the stream and fans out to booking owners + ops dashboards.
 *   - `mission_telemetry_last` stays as the REST fallback for cold boots.
 */
@Module({
  imports:     [AuthModule],
  controllers: [TelemetryController],
  providers:   [TelemetryService],
  exports:     [TelemetryService],
})
export class TelemetryModule {}
